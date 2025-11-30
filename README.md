# Account Buy Sell Server

A Telegram bot and REST API server for facilitating secure account trading between buyers and sellers. The platform provides escrow-style payment verification and order management.

## Features

- **Telegram Bot Integration** - Interactive bot for browsing, buying, and selling accounts
- **Mini App Support** - Web-based interface for listing and searching accounts
- **Payment Verification** - Supports Telebirr and CBE payment methods with receipt verification
- **Order Management** - Track purchases, sales, and order status
- **Session Management** - Redis-backed sessions for persistent user state
- **Escrow System** - Secure payment flow with seller balance management

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Bot Framework**: Telegraf
- **Database**: PostgreSQL (via Drizzle ORM)
- **Session Store**: Upstash Redis
- **File Storage**: Cloudinary
- **Logging**: Winston

## Prerequisites

- Node.js 18+
- PostgreSQL database
- Upstash Redis instance
- Telegram Bot Token (from @BotFather)
- Cloudinary account

## Installation

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your credentials

# Run database migrations
npm run migrate

# Start development server
npm run dev

# Start production server
npm start
```

## Environment Variables

See `.env.example` for all required variables:

| Variable | Description |
|----------|-------------|
| `BOT_TOKEN` | Telegram bot token |
| `MINI_APP_URL` | URL of the mini app frontend |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Upstash Redis URL |
| `REDIS_TOKEN` | Upstash Redis token |
| `CLOUDINARY_*` | Cloudinary credentials |
| `MAINTAINANCE_MODE` | Set to `true` to enable maintenance mode |

## Bot Commands

- `/start` - Start the bot and show main menu
- `/about` - Bot information and developer contact
- `/balance` - Check your current balance
- `/list_my_purchases` - View your purchase history
- `/list_my_sales` - View your sales history

## Scripts

```bash
npm start      # Start production server
npm run dev    # Start with hot reload (nodemon)
npm run generate  # Generate Drizzle migrations
npm run migrate   # Run database migrations
```

## Project Structure

```
├── bot.js          # Telegram bot logic
├── index.js        # Express server entry point
├── db/             # Database schema and migrations
├── utils/          # Utility functions (uploader, logger)
├── logs/           # Application logs
└── .github/        # GitHub Actions workflows
```

