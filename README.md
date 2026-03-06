# Task Manager Telegram Bot

Telegram-бот для управления задачами с AI-распознаванием текста и голоса. Задачи группируются по проектам и отображаются в закреплённом сообщении. Поддерживает напоминания по дате/времени и повторяющиеся уведомления.

## Стек

- **TypeScript** + Node.js
- **grammY** — Telegram Bot framework
- **Prisma** + **PostgreSQL** — база данных
- **Gemini / OpenAI-compatible API** — planner для разбора задач
- **STT provider** — распознавание голосовых сообщений
- **node-cron** — планировщик напоминаний
- **Biome** — линтер и форматтер
- **Husky** — git pre-commit хуки

## Возможности

- Добавление задач текстом или голосом
- AI-парсинг: planner + executor для определения названия, проекта, даты, времени
- Относительные даты: "через час", "завтра в 10", "в пятницу"
- Управление задачами текстом/голосом: удаление, завершение, переименование, перемещение между проектами, изменение дедлайна
- Закреплённое сообщение со списком задач по проектам
- Inline-кнопки для завершения/удаления задач
- Повторяющиеся напоминания (еженедельно, ежемесячно, ежегодно)
- Мультипользовательский — каждый пользователь выбирает свой часовой пояс
- Напоминания по расписанию (проверка каждую минуту)

## Быстрый старт (Docker)

Самый простой способ запустить бота — через Docker Compose.

### 1. Клонировать репозиторий

```bash
git clone https://github.com/maslakovSaveliy/task-bot.git
cd task-bot
```

### 2. Получить токены

- **BOT_TOKEN** — создать бота через [@BotFather](https://t.me/BotFather) в Telegram
- **GEMINI_API_KEY** — получить ключ Gemini API
- **STT_API_KEY** — ключ провайдера распознавания голоса

### 3. Создать `.env` файл

```bash
cp .env.example .env
```

Заполнить:

```env
BOT_TOKEN=123456:ABC-DEF...
DATABASE_URL=postgresql://taskbot:taskbot_secret@db:5432/taskbot
GEMINI_API_KEY=...
STT_API_KEY=...
STT_BASE_URL=https://api.onlysq.ru/ai/openai/
```

### 4. Запустить

```bash
docker compose up -d
```

Бот поднимет PostgreSQL, применит миграции и запустится. Проверить логи:

```bash
docker compose logs -f bot
```

### 5. Остановить

```bash
docker compose down
```

Данные PostgreSQL сохраняются в Docker volume `pgdata`.

## Серверный V1 с Gemini

Для серверного запуска есть отдельный override-файл [docker-compose.server.yml](/Users/savelijmaslakov/DEV/task-manager/docker-compose.server.yml).

Схема:
- `bot` работает как обычно
- planner идёт напрямую в Gemini API
- STT остаётся на текущем провайдере

Подготовка:

```bash
cp .env.server.example .env.server
```

Заполни:
- `GEMINI_API_KEY`
- `STT_API_KEY` и `STT_BASE_URL`

Запуск на сервере:

```bash
docker compose --env-file .env.server -f docker-compose.yml -f docker-compose.server.yml up -d --build
```

Проверка:

```bash
docker compose --env-file .env.server -f docker-compose.yml -f docker-compose.server.yml logs -f bot
```

Ключевые server env:
- `GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/`
- `PRIMARY_CHAT_MODEL=gemini-2.5-flash`
- `FALLBACK_CHAT_MODEL=gemini-2.5-pro`
- `AI_AGENT_MODE=true`

Если на конкретном сервере прямой доступ к Gemini всё же не заработает, VPN/proxy можно вернуть отдельным override позже, не меняя основную серверную конфигурацию.

## Локальная разработка

### Требования

- Node.js 22+
- pnpm 10+
- PostgreSQL 16+

### Установка

```bash
pnpm install
```

### Настроить `.env`

```bash
cp .env.example .env
# заполнить BOT_TOKEN, DATABASE_URL и AI/STT ключи
```

### Применить схему к БД

```bash
DATABASE_URL="postgresql://..." pnpm db:push
```

### Запустить в dev-режиме

```bash
pnpm dev
```

## Команды бота

| Команда | Описание |
|---------|----------|
| `/start` | Запуск и выбор часового пояса |
| `/help` | Справка по всем возможностям |
| `/tasks` | Показать список активных задач |
| `/projects` | Список проектов |
| `/recurring` | Повторяющиеся напоминания |
| `/timezone` | Сменить часовой пояс |

## Структура проекта

```
src/
├── index.ts                 — точка входа
├── bot.ts                   — создание бота, middleware
├── config.ts                — переменные окружения
├── db/client.ts             — Prisma client
├── modules/
│   ├── tasks/               — задачи (handlers, service, renderer, keyboard, pinned)
│   ├── projects/            — проекты (handlers, service)
│   ├── recurring/           — повторяющиеся (handlers, service, keyboard)
│   ├── voice/               — голосовые сообщения
│   └── reminders/           — cron-планировщик
├── services/
│   ├── ai.ts                — planner/executor AI parsing
│   └── stt.ts               — голос → текст
└── types/index.ts           — общие типы
```

## Скрипты

| Скрипт | Описание |
|--------|----------|
| `pnpm dev` | Запуск в watch-режиме (tsx) |
| `pnpm start` | Запуск без watch |
| `pnpm build` | Компиляция TypeScript |
| `pnpm lint` | Проверка Biome |
| `pnpm lint:fix` | Автоисправление Biome |
| `pnpm db:generate` | Генерация Prisma Client |
| `pnpm db:migrate` | Создание миграции |
| `pnpm db:push` | Применение схемы к БД |
