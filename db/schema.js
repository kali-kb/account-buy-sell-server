const { pgEnum, pgTable, text, uuid, integer, boolean, timestamp, index } = require('drizzle-orm/pg-core');
const { relations } = require('drizzle-orm');

const users = pgTable('users', {
    id: uuid('id').defaultRandom().primaryKey(),
    telegram_user_id: text('telegram_user_id').notNull().unique(),
    username: text('username').notNull(),
    account_holder_name: text('account_holder_name'),
    bank_name: text('bank_name'),
    account_number: text('account_number'),
    balance: integer('balance').default(0),
    last_visit: timestamp('last_visit'),
}, (table) => ({
    telegramUserIdIdx: index('users_telegram_user_id_idx').on(table.telegram_user_id),
}));

const accounts = pgTable('accounts', {
    id: uuid('id').defaultRandom().primaryKey(),
    owner_id: uuid('owner_id').notNull().references(() => users.id),
    platform: text('platform_type', { enum: ['youtube_channel', 'telegram_group', 'telegram_channel', 'tiktok_account'] }).notNull(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    price: integer('price').notNull(),
    is_active: boolean('is_active').notNull().default(true),
    status: text('status', { enum: ['available', 'pending', 'sold'] }).notNull().default('available'),
    subscriber_count: integer('subscriber_count').notNull(),
    creation_year: integer('creation_year'),
    is_monetized: boolean('is_monetized'),
    created_at: timestamp('created_at').defaultNow(),
    updated_at: timestamp('updated_at').defaultNow(),
}, (table) => ({
    ownerIdIdx: index('accounts_owner_id_idx').on(table.owner_id),
    statusIdx: index('accounts_status_idx').on(table.status),
    createdAtIdx: index('accounts_created_at_idx').on(table.created_at),
}));

const orders = pgTable('orders', {
    id: uuid('id').defaultRandom().primaryKey(),
    buyer_id: uuid('buyer_id').notNull().references(() => users.id),
    account_id: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    amount: integer('amount').notNull(), // Consider removing this as price is in accounts table
    status: text('status', { enum: ['pending', 'completed', 'cancelled', 'failed'] }).notNull().default('pending'),
    receipt_no: text('receipt_no'),
    created_at: timestamp('created_at').defaultNow(),
    updated_at: timestamp('updated_at').defaultNow(),
}, (table) => ({
    buyerIdIdx: index('orders_buyer_id_idx').on(table.buyer_id),
    accountIdIdx: index('orders_account_id_idx').on(table.account_id),
}));

const transfers = pgTable('transfers', {
    id: uuid('id').defaultRandom().primaryKey(),
    order_id: uuid('order_id').notNull().references(() => orders.id),
    seller_id: uuid('seller_id').notNull().references(() => users.id),
    status: text('status', { enum: ['initiated', 'in_progress', 'completed', 'failed'] }).notNull().default('initiated'),
    created_at: timestamp('created_at').defaultNow(),
    updated_at: timestamp('updated_at').defaultNow(),
});


const withdrawals = pgTable('withdrawals', {
  id: uuid('id').defaultRandom().primaryKey(),
  user_id: uuid('user_id').notNull().references(() => users.id),
  amount: integer('amount').notNull(),
  status: text('status', { enum: ['pending', 'completed', 'rejected'] }).notNull().default('pending'),
  reason: text('reason', { enum: ['order_refund', 'seller_payout'] }).notNull().default('order_refund'),
  created_at: timestamp('created_at').defaultNow(),
  updated_at: timestamp('updated_at').defaultNow(),
});

// Define relations
const usersRelations = relations(users, ({ many }) => ({
    accounts: many(accounts),
    orders: many(orders, { relationName: 'buyer' }),
    transfers: many(transfers, { relationName: 'seller' }),
    withdrawals: many(withdrawals),
}));

const accountsRelations = relations(accounts, ({ one }) => ({
    owner: one(users, {
        fields: [accounts.owner_id],
        references: [users.id],
    }),
}));

const ordersRelations = relations(orders, ({ one }) => ({
    buyer: one(users, {
        fields: [orders.buyer_id],
        references: [users.id],
    }),
    account: one(accounts, {
        fields: [orders.account_id],
        references: [accounts.id],
    }),
}));

const withdrawalsRelations = relations(withdrawals, ({ one }) => ({
    user: one(users, {
        fields: [withdrawals.user_id],
        references: [users.id],
    }),
}));
const transfersRelations = relations(transfers, ({ one }) => ({
    order: one(orders, {
        fields: [transfers.order_id],
        references: [orders.id],
    }),
    seller: one(users, {
        fields: [transfers.seller_id],
        references: [users.id],
    }),
}));

module.exports = {
    users,
    accounts,
    orders,
    transfers,
    withdrawals
};