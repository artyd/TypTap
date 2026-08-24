# Промт: подключить TypTap к бэкенду синхронизации профиля

Скопируйте этот текст целиком в чат вашего AI-инструмента (тот, которым
собирался `TypTap-standalone-src.dc.html` / `TypTap.dc.html`), либо дайте
его любому кодинг-агенту (Claude Code и т.п.) вместе с файлом фронтенда.

---

Ты работаешь с файлом `TypTap-standalone-src.dc.html` — тренажёром слепой
печати. Сейчас весь прогресс пользователя (`class Component extends
DCLogic`, поле `this.store`) хранится только в `localStorage` под ключом
`typtap_v2`. Нужно добавить синхронизацию этого профиля с бэкендом, не
меняя игровую логику и вёрстку.

**Бэкенд уже существует** (Supabase Edge Function) и предоставляет три
эндпоинта. Базовый URL и анонимный ключ будут заданы в глобальных
переменных `window.TYPTAP_API_BASE` и `window.TYPTAP_ANON_KEY`.

```
POST /login
  body: { "nickname": "Maria" }
  ответ: { "nickname": "Maria", "exists": true|false, "data": <профиль или null> }

PUT /profile
  body: { "nickname": "Maria", "data": <весь объект store целиком> }
  ответ: { "ok": true, "updated_at": "..." }

GET /leaderboard?metric=wpm|acc|streak&nickname=Maria
  ответ: {
    "metric": "wpm",
    "top": [{ "nickname": "SwiftKeys", "value": 118, "rank": 1 }, ...],
    "you": { "nickname": "Maria", "value": 76, "rank": 2481 } | null
  }
```

Все запросы — с заголовком `Authorization: Bearer <TYPTAP_ANON_KEY>`.

## Что нужно сделать

1. **Добавить глобальный клиент бэкенда.** Обычным (не `text/x-dc`)
   `<script>`-тегом, ДО `<script type="text/x-dc" data-dc-script>`, задать
   `window.TYPTAP_API_BASE`, `window.TYPTAP_ANON_KEY` и объект
   `window.TypTapSync` с тремя методами:
   - `fetchProfile(nickname)` → `POST /login`, возвращает Promise с ответом
   - `saveProfile(nickname, data)` → дебаунс ~900мс, затем `PUT /profile`
     (несколько вызовов подряд должны схлопываться в один сетевой запрос
     с последними данными)
   - `fetchLeaderboard(metric, nickname)` → `GET /leaderboard`

2. **`_save()`** — сейчас пишет только в `localStorage`. Разбить на
   `_saveLocal()` (старое поведение, синхронно и мгновенно — трогать
   нельзя, на нём завязана вся офлайн-работа) и `_save()`, которая вызывает
   `_saveLocal()` и затем, если `window.TypTapSync` и `this.pdata.current`
   заданы, пушит `this.store` через `TypTapSync.saveProfile(...)`.

3. **`_login(nick)`** — после существующей логики (она не меняется) вызвать
   новый метод `_syncPullProfile(nick)`.

4. **Новый метод `_syncPullProfile(nick)`**: вызывает
   `TypTapSync.fetchProfile(nick)`. Если `exists && data` — сервер
   авторитетен: подменить `this.pdata.profiles[nick]` на `res.data`, если
   это текущий пользователь — обновить `this.store` и вызвать
   `this.forceUpdate()`, затем сохранить локально через `_saveLocal()`
   (НЕ через `_save()`, чтобы не запускать пуш обратно по кругу). Если
   профиля на сервере ещё нет — залить туда текущий локальный через
   `TypTapSync.saveProfile(nick, this.pdata.profiles[nick])`. Ошибки сети
   молча логировать в консоль и не мешать офлайн-работе приложения.

5. **`componentDidMount()`** — в начало (после подписки на `keydown`)
   добавить: если `this.pdata.current` задан — вызвать
   `this._syncPullProfile(this.pdata.current)`.

6. **`_lbView()`** — сейчас строит топ исключительно из захардкоженного
   `_lbSeed()`. Нужно:
   - добавить метод `_syncEnsureLeaderboard(metric)`, который (если ещё не
     загружено для этой метрики и не идёт загрузка) вызывает
     `TypTapSync.fetchLeaderboard(metric, this.pdata.current)` и кладёт
     результат в `this.state.lbRemote = {metric, top, you}` через
     `setState`;
   - в начале `_lbView()` вызвать `this._syncEnsureLeaderboard(metric)`;
   - если `this.state.lbRemote` есть и относится к текущей метрике —
     строить `top3`/`list` из него, а не из `_lbSeed()`; иначе — как раньше,
     из `_lbSeed()` (это фолбэк на время загрузки/офлайн, не убирать);
   - строку `you` (текущий игрок) — если в `lbRemote.you` есть реальный
     ранг, использовать его; иначе оставить старую псевдо-формулу ранга
     как есть.

7. **Ничего больше не менять.** Не трогать код 16 мини-игр, вёрстку,
   переводы, `_lbSeed()` (он остаётся как fallback), `_reset()` и
   `_logout()` — они уже корректно работают через изменённый `_save()`.

8. **Не добавлять пароль/токен.** Авторизация — только ник, без пароля,
   профиль общий для всех устройств с одинаковым ником. Это осознанное
   решение, а не недосмотр.

После изменений результат должен быть синтаксически валидным JS (класс
`Component extends DCLogic` остаётся плоским ES-классом, без JSX внутри
самого JS — JSX/разметка живёт в `<x-dc>...</x-dc>` шаблоне, не в скрипте).
