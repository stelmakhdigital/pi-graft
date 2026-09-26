---
name: graft
description: "Запросы к локальному графу кода Graft (граф функций/классов/методов с точными file:line). Использовать ПЕРЕД grep/read для навигации: «как это работает / где живёт», исчерпывающий поиск по коду, кто зависит от символа, API-поверхность файла, ориентация в чужом репо, blast radius diff. Экономит 10–100× токенов против чтения файлов; каждая выдача начинается с [graft] tokens saved ≈ N."
---

# Graft

Детерминированный код-граф репо: символы (file/function/class/method/type) + рёбра
(calls/imports/references) + опциональный LLM-слой (summaries, crux, concepts).
Хранится в `graft/`, свежесть — в бейдже `graft: synced | ⚠ N stale`.
Выводы retrieval-тулов открываются строкой `[graft] tokens saved ≈ N` — модель
покрывает N токенов файла ценой указателей.

## Когда какой инструмент

| Задача | Инструмент |
|---|---|
| «Как это работает / где живёт» (понимание, не исчерпывающий) | `graft_ask` |
| Все вхождения по regex (исчерпывающе) | `graft_grep` |
| Кто вызывает/импортирует/использует (blast radius, глубина ≤10 или `all`) | `graft_callers` |
| API-поверхность файла до чтения тела | `graft_skeleton` |
| Ориентация в репо (кластеры, хабы, hotspots) | `graft_map` |
| Свежесть/дрейф графа | `graft_check` |
| Что затронет git-diff (blast radius) | `graft_blast` |

Порядок действий в неизученном репо: `graft_map` → `graft_ask` по ключевым
символам → `graft_skeleton` по нашедшимся файлам → читать `read` только
конкретный span (`L<span.start>-L<span.end>`) из выдачи, а не файл целиком.

## Правила экономики

- **Не читать файл целиком, если есть `graft_skeleton`** — 10 раз дешевле;
  span из выдачи указывает, куда смотреть точечно.
- **Не пускать `read` на все результаты `graft_ask`** — брать только
  релевантные spans.
- **`graft_grep` — только когда нужен исчерпывающий список**; для понимания
  достаточно `graft_ask` (ранжирует по значимости и отдаёт crux).
- **Выводы не обрезать** (`| head`/`tail`/`sed`/`cut` ломают постраничные
  срезки и портят `[graft] tokens saved`); при переполнении — сузить запрос
  (scope, `--max-dirs`, depth).
- **Старый граф**: бейдж/`graft_check` показывает stale — перед точечными
  правками по старому символу уточнить `graft_check` и дать `graft build`
  (или довериться freshness-флагу). Не гадать о номерах строк по памяти.
- **LSP-слой** (member-вызовы/наследование через type-checker) — confidence
  `"lsp"` в рёбрах; включается `lsp-sync`. Не требовать, пока нет точности.
- **Monorepo**: если в выдаче `[scope]`-метки — уточнять `scope` в
  `graft_grep`/`graft_ask`, чтобы ответ не терялся в крупном.
- **`graft_ask`-параметры**: `source: true` — код span'а хита (≤8 строк) прямо
  в выдаче (когда хит один-два и читать тело нужно сразу); `limit: N` — сузить
  выдачу; `scope` — подпроект (все инструменты, где есть).
- **Проза-ноды**: если в `graft_ask`-выдаче блок `prose (нарратив…)` — это
  готовые «как это устроено»-описания подсистем (`graft build --deep`); читать
  указанный `graft/prose/*.md` вместо чтения файлов по одному.

## Отчёт об экономии

Когда в ходе ответа использовались graft-тулы, **закончить ответ одной
строкой** (сумма строк `[graft] tokens saved ≈` по тулам, M — число вызовов):

> 🌱 graft сэкономил ~N токенов в этом turn (M вызовов)

Если graft-тулы не использовались — строку не писать.

## Когда графа не хватает

- Динамическое / runtime-поведение (reflection, eval, DI-контейнеры) — граф
  статический; дополнять `read`.
- Тесты/конфиги/CI — не в графе как «символы», смотреть `graft_grep`
  или `read`.
- Третий код (node_modules) — не индексируется; `read` + web-поиск.
- Свежие правки ещё не в графе (auto-rebuild debounce 4 c) — `graft_check`
  и локальный `read`.

## CLI и MCP (для людей и других агентов)

- CLI: `node engine/bin/graft.mjs <cmd>` — build/check/map/ask/grep/
  callers/skeleton/blast/viz/lsp-status/lsp-sync/init/uninstall.
- MCP: `node engine/bin/graft-mcp.mjs --root <root>` (stdio) — те же
  инструменты через MCP-протокол для любых LLM-хостов.
- Deep-слой (summaries/crux/concepts): только при явном конфиге LLM —
  env `GRFT_LLM_BASE_URL`/`GRFT_LLM_MODEL`/`GRFT_LLM_API_KEY` или файл
  (`graft config set` / `graft config show`; project: `<repo>/graft/.engine/llm.json`,
  global: `~/.config/pi-graft/llm.json`; опц. `--temperature`, `--timeout-ms`);
  runtime-ручки (env → `graft/.engine/config.json`): `--no-refresh`, `--auto-deep`,
  `--follow-submodules`, `--refresh-mode size|hash`, `--refresh-timeout-ms`, `--max-output`.
  Env-только (machine-level): `GRFT_STATE_DIR`, `GRFT_MCP_ROOT`, `GRFT_LLM_CONFIG`.
