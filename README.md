# composable-action-runners

Des runners self-hosted pour plusieurs organisations sur un même hôte Linux, sans qu'ils se
marchent dessus : **un conteneur neuf par job**, détruit après, et autant de runners par org que
`config/runners.yml` en demande.

```
docker compose
├── runner-image   build de l'image runner (gha-runner:local), rien d'autre
└── manager        tient chaque pool à son effectif ; seul détenteur du socket Docker et des credentials GitHub
        │  par runner : generate-jitconfig (GitHub) → docker create + start
        ▼
    gha-<prefix>-<pool>-xxxxxx   1 conteneur = 1 runner JIT = 1 job, puis supprimé et remplacé
```

## Comment ça marche

- **Enregistrement JIT.** Pour chaque runner, le manager appelle
  `POST /orgs/{org}/actions/runners/generate-jitconfig` et passe la config obtenue au conteneur
  (`ACTIONS_RUNNER_INPUT_JITCONFIG`, que le runner efface de son environnement avant tout job). Un
  runner JIT est éphémère par construction : il prend un seul job, puis GitHub le supprime. Aucun
  token d'enregistrement ni credential d'org n'entre dans un conteneur runner.
- **Boucle de réconciliation** (toutes les `TICK_SECONDS`, 10 s) :
  1. les conteneurs arrêtés sont supprimés et leur enregistrement GitHub effacé (en général déjà
     parti) ; un échec est loggé avec la fin des logs du runner ;
  2. chaque pool sous son `count` reçoit de nouveaux runners ;
  3. un pool au-dessus de son `count` (effectif baissé, pool retiré) perd ses runners **idle**.
     L'enregistrement est supprimé d'abord, ce que GitHub refuse (422) sur un runner occupé : un
     job en cours n'est jamais coupé ;
  4. toutes les `GC_MINUTES`, les enregistrements offline au préfixe de l'hôte que plus aucun
     conteneur ne porte (crash de l'hôte, `docker rm -f`) sont supprimés.
- **Config à chaud.** `config/runners.yml` est relu à chaque tick. Une config invalide est loggée et
  la précédente reste active.
- **Backoff.** Un runner qui meurt au démarrage, un enregistrement refusé ou une image absente
  mettent le pool en pause de 15 s, puis 30 s, et ainsi de suite jusqu'à 5 min, au lieu de boucler
  sur l'API GitHub. `run.sh` sort en 0 même quand le listener échoue : l'entrypoint convertit
  « aucun job exécuté » en code 70 pour que l'échec soit visible.
- **Arrêt** (`docker compose down`, SIGTERM). Les runners idle partent tout de suite, les runners
  busy ont `DRAIN_SECONDS` (300 s) pour finir leur job, puis ils sont arrêtés.

## Isolation

| Entre | Mécanisme |
|---|---|
| deux jobs successifs | conteneur détruit après chaque job : `$HOME` (configs et tokens laissés par les outils), `/tmp`, `_work`, paquets installés, processus orphelins disparaissent |
| deux jobs simultanés | conteneurs distincts ; réseau par pool avec `enable_icc=false` (aucun trafic entre runners) |
| jobs et hôte | pas de socket Docker, pas de `--privileged`, `init` (tini) en PID 1, `NET_RAW`/`MKNOD`/`SYS_CHROOT`/`SETFCAP` retirés ; `sudo: false` ajoute `no-new-privileges` et retire toutes les capabilities |
| jobs et credentials | les PAT/clé d'App restent dans le manager ; un runner ne connaît que sa config JIT |
| ressources | `cpus`, `memory` (swap désactivé), `pids`, `shm`, et `disk` en option, par runner |
| orgs | un pool = une org ; ses runners ne sont enregistrés que là, sur leur propre réseau |

Ce qui n'est **pas** isolé par défaut, à régler sur l'hôte :

- **Le réseau sortant.** Un job atteint Internet, mais aussi le LAN de l'hôte et, chez un cloud
  provider, le service de métadonnées (`169.254.169.254`, qui peut livrer les credentials de la
  VM). À bloquer dans la chaîne `DOCKER-USER`, par exemple :
  ```bash
  sudo iptables -I DOCKER-USER -s 172.16.0.0/12 -d 169.254.169.254 -j DROP
  sudo iptables -I DOCKER-USER -s 172.16.0.0/12 -d 10.0.0.0/8 -j DROP
  sudo iptables -I DOCKER-USER -s 172.16.0.0/12 -d 192.168.0.0/16 -j DROP
  ```
  Adapter les plages à `docker network inspect gha-<prefix>-<pool>`, et rendre les règles
  persistantes (`iptables-persistent` ou équivalent).
- **Le disque.** Sans `disk`, un job peut remplir la partition de Docker. `disk` ne marche
  qu'avec overlay2 sur xfs monté avec `pquota`. Sinon, mettre `/var/lib/docker` sur une partition
  dédiée.
- **Le noyau.** Les conteneurs partagent le noyau de l'hôte. Pour du code non fiable (PR de forks
  sur un dépôt public), utiliser `runtime: runsc` (gVisor), ou ne pas servir les dépôts publics
  (réglage du runner group).
- **Les caches** (`caches:`) sont partagés par les runners d'un pool et survivent aux jobs : un job
  peut empoisonner ce que lira le suivant. À réserver à des dépôts de même confiance.

**Docker dans les jobs** (`services:`, `container:`, `docker build`) : non disponible par défaut,
volontairement (le socket de l'hôte, c'est root sur l'hôte). Pour l'activer sans `--privileged`,
installer [Sysbox](https://github.com/nestybox/sysbox) sur l'hôte et poser `runtime: sysbox-runc`
sur le pool ; il faut alors aussi un `dockerd` dans l'image runner (pas encore fait).

## Mise en place sur l'hôte Linux

Prérequis : Docker Engine 24+ avec le plugin compose. L'architecture (x64 ou arm64) est détectée.

1. **Credentials GitHub**, une des trois options (détail dans `.env.example`) :
   - **GitHub App** (recommandé) : créer une App avec la seule permission d'organisation
     *Self-hosted runners: Read and write*, l'installer sur chaque org, et poser sa clé privée en
     `secrets/github-app.pem`. Une App installable sur plusieurs orgs doit être publique (« Any
     account ») : cela permet seulement à une org de l'installer, pas d'utiliser vos installations.
   - **Un fine-grained PAT par org** : propriétaire de la ressource = l'org, permission
     d'organisation *Self-hosted runners: Read and write*, rien d'autre. À mettre dans
     `GITHUB_TOKEN_<ORG>`.
   - **Un PAT classic** `admin:org` pour toutes les orgs : le plus simple, mais le plus large.
2. **Configurer** :
   ```bash
   cp .env.example .env                                # RUNNER_NAME_PREFIX unique par hôte + credentials
   cp config/runners.example.yml config/runners.yml    # les pools de cet hôte (ignoré par git)
   $EDITOR config/runners.yml
   ```
3. **Démarrer** :
   ```bash
   docker compose up -d --build
   docker compose logs -f manager
   ```
4. **Retirer les anciens runners** de la machine (service `actions.runner.*` : `./svc.sh stop &&
   ./svc.sh uninstall && ./config.sh remove`), puis adapter le `runs-on` des workflows aux labels
   des pools.

## Exploitation

| Besoin | Commande |
|---|---|
| état des runners | `docker ps --filter label=gha.manager=<prefix> --format '{{.Names}}\t{{.Label "gha.org"}}\t{{.Status}}'` |
| logs du manager | `docker compose logs -f manager` |
| logs d'un runner en cours | `docker logs -f <nom>` (les logs de job restent sur GitHub) |
| changer un effectif ou des ressources | éditer `config/runners.yml` : appliqué en 10 s ; les runners déjà lancés gardent leurs limites jusqu'à leur job |
| mettre à jour le runner | `docker compose build --pull runner-image` (à mettre en cron hebdo) : les nouveaux conteneurs prennent la nouvelle image, les anciens finissent leur job |
| mettre à jour le manager | `docker compose up -d --build manager` : il draine (idle tout de suite, busy jusqu'à 300 s) puis redémarre |
| tout arrêter | `docker compose down` |

GitHub refuse les jobs aux versions de runner trop anciennes, et une image en retard fait
s'auto-mettre à jour chaque conteneur neuf avant son premier job : rebuilder l'image
régulièrement.

## Dimensionnement

Les limites sont des plafonds par runner, pas des réservations. Le manager prévient quand
`count × cpus` ou `count × memory` dépasse l'hôte, sans refuser : des runners idle ne consomment
presque rien, mais des runners tous occupés en même temps se disputent le CPU, et la mémoire
finit en OOM kill (loggé : `OOM-killed (raise the pool memory)`).

## Développement du manager

```bash
cd manager && bun install && bun test && bun run typecheck
```

`src/plan.ts` contient les décisions pures (quoi récolter, lancer, retirer ; le spec du
conteneur) : c'est là que vont les tests. `src/main.ts` fait les I/O.
