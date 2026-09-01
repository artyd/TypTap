# Деплой TypTap на свій сервер (`typtap.alliancegroup95.com`)

Схема (на сервері вже стоїть **Caddy**, який робить автоматичний HTTPS):

```
Браузер ──HTTPS──> Caddy (автосертифікат Let's Encrypt)
                     ├─ /            → статика: index.html, support.js, Mascot.dc.html
                     └─ /api/*       → 127.0.0.1:8010 (Docker: api)  → Postgres (Docker)
```

Бекенд (Node + Postgres) працює в Docker і слухає **лише** loopback на порту
**8010**. Назовні все віддає Caddy, він же тримає TLS. Профіль гравця — за
ніком, без пароля; при першому вході з новим ніком профіль створюється сам.

Сервер: Ubuntu/Debian з sudo. Усі команди — на сервері по SSH.

---

## 0. Один раз

- **DNS:** A-запис `typtap` → IP сервера (перевірка: `dig +short typtap.alliancegroup95.com`).
- **Порти 80 і 443** відкриті (Caddy сам випускає сертифікат через них).
- **Docker + Compose:**
  ```bash
  curl -fsSL https://get.docker.com | sudo sh
  sudo docker compose version
  ```
- **Caddy** уже встановлено (за умовою). Перевір: `caddy version` і `systemctl status caddy`.

---

## 1. Отримати код

```bash
sudo mkdir -p /opt/typtap && sudo chown "$USER" /opt/typtap
git clone https://github.com/artyd/TypTap.git /opt/typtap
cd /opt/typtap
```

(Оновлення пізніше — `git pull` у цій же папці.)

---

## 2. Підняти бекенд у Docker (порт 8010)

```bash
cd /opt/typtap
cp .env.example .env
nano .env            # ОБОВ'ЯЗКОВО задай POSTGRES_PASSWORD (напр. `openssl rand -hex 24`)

sudo docker compose up -d --build
```

Перевірка (бекенд слухає 127.0.0.1:8010):

```bash
curl -s http://127.0.0.1:8010/health           # -> {"ok":true}
sudo docker compose logs api --tail=30          # "applied migration 0001_init.sql", "listening on :8787"
```

Швидкий тест API:

```bash
curl -s -X POST http://127.0.0.1:8010/login \
  -H 'content-type: application/json' -d '{"nickname":"Test"}'
# -> {"nickname":"Test","exists":false,"data":null}

curl -s -X PUT http://127.0.0.1:8010/profile \
  -H 'content-type: application/json' \
  -d '{"nickname":"Test","data":{"sessions":[{"wpm":72,"acc":98.5,"mode":"lesson","lang":"en"}],"xp":120,"streak":{"count":3}}}'
# -> {"ok":true,...}

curl -s "http://127.0.0.1:8010/leaderboard?metric=wpm&nickname=Test"
# -> {"metric":"wpm","top":[{"nickname":"Test","value":72,"rank":1}],"you":{...}}
```

---

## 3. Статика (те, що віддає Caddy)

```bash
sudo mkdir -p /var/www/typtap
sudo cp /opt/typtap/index.html /opt/typtap/support.js /opt/typtap/Mascot.dc.html /var/www/typtap/
```

---

## 4. Caddy

Додай сайт-блок з `caddy/Caddyfile` до конфігу Caddy. Найпростіше —
підключити файл репозиторію через `import`:

```bash
# один раз: додати import у головний Caddyfile (якщо ще немає)
grep -q 'import /opt/typtap/caddy/Caddyfile' /etc/caddy/Caddyfile || \
  echo 'import /opt/typtap/caddy/Caddyfile' | sudo tee -a /etc/caddy/Caddyfile

sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

> Або просто скопіюй вміст `caddy/Caddyfile` у свій `/etc/caddy/Caddyfile`
> вручну. `handle_path /api/*` зрізає префікс `/api`, тому бекенд отримує
> `/login`, `/profile`, `/leaderboard`.

Перевірка (Caddy сам візьме сертифікат за хвилину):

```bash
curl -s https://typtap.alliancegroup95.com/api/health    # -> {"ok":true}
```

Відкрий **https://typtap.alliancegroup95.com** — зайди за ніком, пройди урок,
відкрий «Таблицю лідерів»: там живі дані з БД, твій результат — з реальним місцем.

---

## Оновлення

**Фронтенд (index.html / support.js):**
```bash
cd /opt/typtap && git pull
sudo cp index.html support.js Mascot.dc.html /var/www/typtap/
```
(Caddy перезавантажувати не треба — статика читається з диска.)

**Бекенд (щось у backend/):**
```bash
cd /opt/typtap && git pull
sudo docker compose up -d --build
```

**Caddyfile змінився:**
```bash
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

---

## Бекап БД

```bash
cd /opt/typtap
sudo docker compose exec -T db pg_dump -U "$(grep POSTGRES_USER .env|cut -d= -f2)" \
  "$(grep POSTGRES_DB .env|cut -d= -f2)" > typtap-backup-$(date +%F).sql
```
Відновлення:
```bash
cat typtap-backup-YYYY-MM-DD.sql | sudo docker compose exec -T db \
  psql -U "$(grep POSTGRES_USER .env|cut -d= -f2)" "$(grep POSTGRES_DB .env|cut -d= -f2)"
```
Дані Postgres — у docker-volume `typtap_pgdata` (переживають перезбірку).
Повне стирання БД: `docker compose down -v` (**видалить усі профілі**).

---

## Діагностика

| Симптом | Перевір |
|---|---|
| `/api/health` не відповідає | `sudo docker compose ps`, `sudo docker compose logs api` |
| api не стартує, «database not reachable» | `sudo docker compose logs db`; пароль у `.env` збігається? |
| Порт 8010 зайнятий | `sudo ss -ltnp | grep 8010` — зміни хост-порт у `docker-compose.yml` і в `caddy/Caddyfile` |
| Прогрес не синхронізується між пристроями | DevTools → Network: чи йдуть запити на `/api/login`, `/api/profile` і який статус |
| Лідерборд показує демо-імена (SwiftKeys…) | Це офлайн-фолбек — `/api/leaderboard` недоступний; перевір п.4 |
| Caddy не бере сертифікат | DNS ще не вказує на сервер або закриті порти 80/443 |

Застосунок **повністю працює офлайн**: якщо бекенд недоступний, прогрес
пишеться в localStorage, а лідерборд показує демо-список. Синхронізація
підхопиться сама, щойно api знову відповість.

> Альтернатива Caddy — host-nginx + certbot: див. `nginx/typtap.conf`
> (тоді проксі на `127.0.0.1:8010`). Але з наявним Caddy це не потрібно.
