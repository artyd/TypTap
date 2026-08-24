# TypTap — бэкенд для синхронизации профиля

Тренажёр печати TypTap изначально хранил весь прогресс (сессии, streak,
пройденные уроки, xp, рекорды мини-игр) только в `localStorage` браузера —
на другом устройстве или в другом браузере профиль был недоступен.

Этот репозиторий добавляет к нему настоящий бэкенд на **Supabase**
(Postgres + Edge Function), чтобы профиль по нику синхронизировался между
устройствами. Фронтенд как был одним статическим HTML-файлом (без сборки,
без npm) — так и остался, просто теперь умеет ходить в API.

## Как это устроено

```
┌─────────────────────┐        HTTPS         ┌──────────────────────────┐
│  index.html          │ ───────────────────▶ │  Supabase Edge Function   │
│  (GitHub Pages,      │  fetch('/login' и т.д)│  supabase/functions/api  │
│  статика, без сборки)│ ◀─────────────────────│  (Deno)                  │
└─────────────────────┘                        └────────────┬─────────────┘
                                                              │ service_role
                                                              ▼
                                                     ┌──────────────────┐
                                                     │  Postgres         │
                                                     │  table: profiles  │
                                                     └──────────────────┘
```

- **Никакого пароля.** Как и раньше — просто ник. Отличие только в том, что
  теперь профиль с этим ником общий для всех устройств, а не заперт в одном
  браузере. Это осознанный компромисс ради простоты: любой, кто наберёт тот
  же ник, увидит и сможет изменить тот же профиль. Если позже захотите это
  закрыть — можно добавить необязательный PIN одним новым полем в БД и одной
  проверкой в `supabase/functions/api/index.ts`, не трогая остальное.
- **localStorage не убран, а стал кэшем.** Приложение мгновенно читает и
  пишет локально (как раньше — ноль задержек, работает офлайн), а в фоне с
  дебаунсом ~900мс синхронизирует профиль с сервером. При входе / загрузке
  страницы тянет свежую версию с сервера, если она есть.
- **Игровая логика не тронута.** Все 16 мини-игр (falling, race, boss,
  cipher, maze и т.д.) продолжают писать статистику в `this.store` как
  раньше — синхронизируется весь объект целиком (jsonb), поэтому бэкенду не
  нужно ничего знать про конкретные поля вроде `bestClimb` или `bossWins`.
- **Лидерборд стал настоящим.** Раньше `_lbSeed()` — захардкоженный список.
  Теперь `/leaderboard` считает реальный топ по всем синхронизированным
  профилям (best WPM / best accuracy / streak). Захардкоженный список
  остался как мгновенный fallback, пока идёт первая загрузка или если
  бэкенд недоступен (офлайн).

## Что где лежит

```
index.html                          — фронтенд (было TypTap-standalone-src.dc.html), с уже применённым патчем
support.js, Mascot.dc.html          — рантайм и подкомпонент, нужны рядом с index.html
supabase/migrations/0001_init.sql   — схема БД (таблица profiles)
supabase/functions/api/index.ts     — вся серверная логика (Deno Edge Function)
supabase/config.toml                — конфиг Supabase CLI
.github/workflows/deploy-backend.yml— пуш в main → миграции + функция деплоятся в Supabase
.github/workflows/deploy-pages.yml  — пуш в main → index.html публикуется на GitHub Pages
PROMPT.md                           — промт для AI-инструмента, которым собирался фронтенд
```

## Настройка (один раз)

### 1. Supabase-проект

1. Зарегистрируйтесь на [supabase.com](https://supabase.com) → **New project**
   (бесплатного тарифа хватает с большим запасом).
2. В **Project Settings → API** скопируйте:
   - `Project URL` (вида `https://xxxx.supabase.co`)
   - `anon public` ключ
   - `service_role` ключ (секретный!)
   - **Reference ID** проекта (он же `project-ref`, тот же `xxxx` из URL)

### 2. Секреты в GitHub-репозитории

`Settings → Secrets and variables → Actions → New repository secret`:

| Secret | Откуда взять |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | supabase.com → аккаунт → Access Tokens → создать новый |
| `SUPABASE_PROJECT_REF` | Project Settings → General → Reference ID |
| `SUPABASE_DB_PASSWORD` | пароль от БД, который вы задали при создании проекта |

После этого запушьте в `main` — workflow **Deploy backend (Supabase)**
сам накатит миграцию и задеплоит функцию `api`. Проверить вручную:

```bash
npx supabase login
npx supabase link --project-ref <ваш-project-ref>
npx supabase db push
npx supabase functions deploy api
```

### 3. service_role ключ для Edge Function

Deno-функция читает `SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` из
переменных окружения — Supabase подставляет их автоматически для каждой
Edge Function, вручную задавать не нужно.

### 4. Подставить ключи во фронтенд

В `index.html` найдите (в начале блока `<script>` перед `TypTapSync`):

```js
window.TYPTAP_API_BASE = 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/api';
window.TYPTAP_ANON_KEY = 'YOUR-SUPABASE-ANON-KEY';
```

Замените на реальные `project-ref` и `anon public` ключ из шага 1
(этот ключ публичный, его не нужно прятать — приватность обеспечивает
`service_role`, который живёт только на сервере).

### 5. GitHub Pages

`Settings → Pages → Source → GitHub Actions` — workflow
**Deploy frontend (GitHub Pages)** сам публикует `index.html` +
`support.js` + `Mascot.dc.html` при каждом пуше в `main`.

## API

Базовый URL: `https://<project-ref>.supabase.co/functions/v1/api`
Все запросы требуют заголовок `Authorization: Bearer <anon key>`.

| Метод | Путь | Тело / query | Ответ |
|---|---|---|---|
| `POST` | `/login` | `{ "nickname": "Maria" }` | `{ nickname, exists, data }` |
| `PUT`  | `/profile` | `{ "nickname": "Maria", "data": {...} }` | `{ ok: true, updated_at }` |
| `GET`  | `/leaderboard?metric=wpm\|acc\|streak&nickname=Maria` | — | `{ metric, top: [...], you }` |

`data` — это ровно тот объект, что раньше лежал в `localStorage` под
`pdata.profiles[nick]` (`sessions`, `streak`, `completed`, `xp`, `bestRace`
и любые другие поля, которые допишут игры).

## Локальная разработка backend'а

```bash
npx supabase start        # локальный Postgres + Edge Functions в Docker
npx supabase functions serve api --env-file supabase/.env.local
```

## Если фронтенд будет пересобираться заново в вашем AI-инструменте

Патч в `index.html` — это ~30 строк, добавленных в конкретные места
класса `Component` (см. `PROMPT.md`). Если вы отредактируете исходник
через инструмент, которым изначально собирался TypTap, и получите новый
бандл — просто скормите промт из `PROMPT.md` этому инструменту, он внесёт
те же изменения заново.
