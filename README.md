# Task Manager Telegram Bot

Telegram-бот для управления задачами с AI-распознаванием текста и голоса. Задачи группируются по проектам и отображаются в закреплённом сообщении. Поддерживает напоминания по дате/времени и повторяющиеся уведомления.

## Стек

- **TypeScript** + Node.js
- **grammY** — Telegram Bot framework
- **Prisma** + **PostgreSQL** — база данных
- **Groq API** — Llama 3.1 8B (парсинг задач) + Whisper Large v3 Turbo (голос в текст)
- **node-cron** — планировщик напоминаний
- **Biome** — линтер и форматтер
- **Husky** — git pre-commit хуки

## Возможности

- Добавление задач текстом или голосом
- AI-парсинг: автоматическое определение названия, проекта, даты, времени
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
- **GROQ_API_KEY** — зарегистрироваться на [console.groq.com](https://console.groq.com) и создать API-ключ (бесплатно)

### 3. Создать `.env` файл

```bash
cp .env.example .env
```

Заполнить:

```env
BOT_TOKEN=123456:ABC-DEF...
DATABASE_URL=postgresql://taskbot:taskbot_secret@db:5432/taskbot
GROQ_API_KEY=gsk_...
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
# заполнить BOT_TOKEN, DATABASE_URL, GROQ_API_KEY
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
│   ├── ai.ts                — Groq LLM парсинг задач
│   └── stt.ts               — Groq Whisper (голос → текст)
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
