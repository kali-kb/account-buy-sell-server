const { Telegraf, Markup, session } = require('telegraf');
const dotenv = require('dotenv');
const { Redis } = require('@upstash/redis');
const FormData = require('form-data');
const { cloudinaryUploader, deleteFromCloudinary } = require('./utils/uploader.js');
const logger = require('./utils/logger');

dotenv.config();

// Initialize Redis client
let redis;
try {
  redis = new Redis({
    url: process.env.REDIS_URL,
    token: process.env.REDIS_TOKEN,
  });
} catch (e) {
  logger.error('Failed to initialize Redis client', { error: e.message });
}

const redisSession = {
  get: async (key) => {
    if (!redis) return {};
    try {
      const data = await redis.get(key);
      return data || {};
    } catch (e) {
      logger.error('Redis get error', { error: e.message });
      return {};
    }
  },
  set: async (key, value) => {
    if (!redis) return;
    try {
      await redis.set(key, value);
    } catch (e) {
      logger.error('Redis set error', { error: e.message });
    }
  },
  delete: async (key) => {
    if (!redis) return;
    try {
      await redis.del(key);
    } catch (e) {
      logger.error('Redis delete error', { error: e.message });
    }
  }
};

const bot = new Telegraf(process.env.BOT_TOKEN);
const MINI_APP_URL = process.env.MINI_APP_URL;
const REQUIRE_PAYMENT_SCREENSHOT = false; // Flag to toggle payment screenshot verification

// Maintenance mode middleware - MUST be before session to avoid Redis connection errors
const MAINTENANCE_MODE = process.env.MAINTAINANCE_MODE === 'true';
bot.use(async (ctx, next) => {
  if (MAINTENANCE_MODE) {
    const maintenanceMessage = `🔧 *Maintenance Mode*\n\n` +
      `The bot is currently undergoing maintenance and will be back shortly.\n\n` +
      `Please try again later. Thank you for your patience! 🙏`;
    
    try {
      await ctx.reply(maintenanceMessage, { parse_mode: 'Markdown' });
    } catch (e) {
      // Ignore errors (e.g., if bot was blocked)
    }
    return; // Don't process any further
  }
  return next();
});

bot.use(session({ store: redisSession }));

// Helper function to update last_visit
async function updateUserVisit(userId) {
  if (!userId) return;
  try {
    await fetch(`${process.env.API_URL || `http://localhost:3001`}/users/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ last_visit: new Date().toISOString() })
    });
    logger.info('User visit updated', { userId });
  } catch (error) {
    logger.error('Failed to update last_visit', { error: error.message, userId });
  }
}

const VISIT_UPDATE_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Middleware to update last_visit on user interaction
bot.use(async (ctx, next) => {
  // We need user data in the session for this to work
  if (ctx.session && ctx.session.user && ctx.session.user.id) {
    const now = new Date().getTime();
    // Get last update time from session, default to 0 if not present
    const lastVisitUpdate = ctx.session.lastVisitUpdate || 0;

    if (now - lastVisitUpdate > VISIT_UPDATE_INTERVAL) {
      await updateUserVisit(ctx.session.user.id);
      // Store the new update time in the session
      ctx.session.lastVisitUpdate = now;
    }
  }
  return next();
});

// Welcome message and main keyboard
const getMainKeyboard = () => {
  return Markup.keyboard([
    ['For Buying', 'For Selling'],
    ['📄 Rules and guidelines'],
    ['Invite Friends'],
  ]).resize();
};

// Helper function to safely parse JSON response
const safeJsonParse = async (response) => {
  const text = await response.text();
  if (!text || text.trim() === '') {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    logger.error('JSON parse error', { error: error.message, responseText: text });
    return null;
  }
};

// Helper function to escape Markdown special characters
function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// Start command with welcome message and keyboard
bot.command('start', async (ctx) => {
  const welcomeMessage = `Welcome to the Account Trading Bot! 🎉\n\n` +
    `Please select an option from the menu below:`;

  const telegram_user_id = ctx.from.id.toString();
  const username = ctx.from.username || '';
  let userData = null;

  try {
    const res = await fetch(`${process.env.API_URL || `http://localhost:3001`}/users/by-telegram/${telegram_user_id}`);

    if (res.ok) {
        userData = await safeJsonParse(res);
        if (userData) {
            logger.info('User exists', { userId: userData.id, username: userData.username });
        }
    } else if (res.status === 404) {
        // User not found, create one.
        const createRes = await fetch(`${process.env.API_URL || `http://localhost:3001`}/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ telegram_user_id, username })
        });

        if (createRes.ok) {
            userData = await safeJsonParse(createRes);
            if (userData) {
                logger.info('User created', { userId: userData.id, username: userData.username });
            }
        } else {
            const err = await safeJsonParse(createRes);
            logger.error('Failed to create user', { error: err, telegram_user_id, username });
            // Check for specific username error from backend
            if (createRes.status === 400 && err?.error?.includes("Username is required")) {
                await ctx.reply('Welcome! To use this bot, you must have a public Telegram username. Please set one in your Telegram settings and then type /start again.');
                return; // Stop processing and don't show the main keyboard
            }
        }
    } else {
        // Handle other HTTP errors
        const err = await safeJsonParse(res);
        logger.error('Failed to fetch user', { error: err, telegram_user_id });
    }
  } catch (e) {
    logger.error('Error creating or fetching user on start', { error: e.message, telegram_user_id });
  }

  // Update last visit time
  if (userData && userData.id) {
    await updateUserVisit(userData.id);
  }

  // Save user data in session (in-memory, per bot instance)
  if (userData) {
    ctx.session.user = {
      id: userData.id,
      telegram_user_id,
      username: userData.username
    };
  } else {
    // Set a fallback user session to prevent errors
    ctx.session.user = {
      id: null,
      telegram_user_id,
      username
    };
  }

  try {
    await ctx.reply(welcomeMessage, getMainKeyboard());
  } catch (error) {
    if (error.code === 403 && error.description.includes('bot was blocked by the user')) {
      logger.warn('Bot was blocked by the user, skipping welcome message.', { userId: ctx.session.user?.id, telegram_user_id: ctx.from.id });
    } else {
      // Re-throw other errors
      throw error;
    }
  }
});

// About command
bot.command('about', (ctx) => {
  const aboutMessage = `🤖 Bot Information\n\n` +
    `Developer: @kbmati9\n` +
    `Contact for support or inquiries\n\n` +
    `This bot helps facilitate account trading in a secure environment.`;
  
  ctx.reply(aboutMessage);
});

bot.command('balance', async (ctx) => {
  const { user } = ctx.session;
  if (!user || !user.id) {
    return ctx.reply('You are not logged in. Please use /start to log in.');
  }

  try {
    const apiUrl = process.env.API_URL || 'http://localhost:3001';
    const response = await fetch(`${apiUrl}/users/${user.id}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (response.ok) {
      const userData = await response.json();
      const balanceMessage = `💰 Your current balance: ${userData.balance} ETB`;
      
      const withdrawButton = {
        inline_keyboard: [
          [{ text: '💳 Withdraw Balance', callback_data: 'withdraw_balance' }]
        ]
      };

      ctx.reply(balanceMessage, { reply_markup: withdrawButton });
    } else {
      ctx.reply('Failed to fetch balance. Please try again later.');
    }
  } catch (error) {
    logger.error('Error fetching balance', { error: error.message, stack: error.stack, userId: ctx.session.user?.id });
    ctx.reply('An error occurred while fetching your balance.');
  }
});

const ITEMS_PER_PAGE = 5;

async function sendOrdersPage(ctx, title = '📄 Your Orders', edit = false) {
  const { orders, orders_page = 0 } = ctx.session;

  if (!orders || orders.length === 0) {
    let text = 'You have no orders yet.';
    
    // Check if we're showing purchases or sales based on the title
    if (title && title.includes('Purchases')) {
      text = 'You have no purchases yet.';
    } else if (title && title.includes('Sales')) {
      text = 'You have no sales yet.';
    }
    
    if (edit) {
      try {
        return await ctx.editMessageText(text, { reply_markup: { inline_keyboard: [] } });
      } catch (e) {
        if (!e.message.includes('message is not modified')) logger.error('Error in sendOrdersPage', { error: e.message, stack: e.stack });
        return;
      }
    }
    return ctx.reply(text);
  }

  if (edit) {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      // Ignore if cannot delete
    }
  }

  const totalPages = Math.ceil(orders.length / ITEMS_PER_PAGE);
  const currentPage = orders_page;

  const start = currentPage * ITEMS_PER_PAGE;
  const end = start + ITEMS_PER_PAGE;
  const paginatedOrders = orders.slice(start, end);

  await ctx.reply(`${title} (Page ${currentPage + 1}/${totalPages})`);

  const isSale = title.includes('Sales');

  for (const item of paginatedOrders) {
    const { order, account, user, seller } = item;
    const date = new Date(order.created_at).toLocaleDateString();

    let orderInfo = `🧾 *Account:* ${escapeMarkdown(account.name)}\n`;
    if (isSale) {
      orderInfo += `👤 *Buyer:* @${escapeMarkdown(user.username)}\n`;
    } else {
      const sellerUsername = seller ? seller.username : 'N/A';
      orderInfo += `👤 *Seller:* @${escapeMarkdown(sellerUsername)}\n`;
    }
    orderInfo += `💰 *Amount:* ${escapeMarkdown(order.amount.toString())} ETB\n`;
    orderInfo += `💳 *Status:* ${escapeMarkdown(order.status)}\n`;
    orderInfo += `📅 *Date:* ${escapeMarkdown(date)}`;

    const keyboard = [];
    if (isSale && order.status === 'pending') {
      keyboard.push([Markup.button.callback('Initiate Account Transfer', `initiate_transfer_${order.id}`)]);
    }
    // Add Cancel Order button for purchases (not sales) with status 'pending'
    if (!isSale && order.status === 'pending') {
      keyboard.push([Markup.button.callback('❌ Cancel Order', `cancel_order_${order.id}`)]);
    }
    const extra = {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    };

    await ctx.reply(orderInfo, extra);
  }

  const paginationKeyboard = [];
  const row = [];

  if (currentPage > 0) {
    row.push(Markup.button.callback('⬅️ Previous', 'orders_page_prev'));
  }

  if (end < orders.length) {
    row.push(Markup.button.callback('Next ➡️', 'orders_page_next'));
  }

  if (row.length > 0) {
    paginationKeyboard.push(row);
  }

  if (paginationKeyboard.length > 0) {
    await ctx.reply('Navigate orders:', { reply_markup: { inline_keyboard: paginationKeyboard } });
  }
}

bot.action('orders_page_next', async (ctx) => {
  if (ctx.session.orders_page !== undefined) {
    const totalPages = Math.ceil(ctx.session.orders.length / ITEMS_PER_PAGE);
    if (ctx.session.orders_page + 1 < totalPages) {
        ctx.session.orders_page++;
    }
  }
  await sendOrdersPage(ctx, ctx.session.orders_title, true);
  await ctx.answerCbQuery();
});

bot.action('orders_page_prev', async (ctx) => {
  if (ctx.session.orders_page !== undefined && ctx.session.orders_page > 0) {
    ctx.session.orders_page--;
  }
  await sendOrdersPage(ctx, ctx.session.orders_title, true);
  await ctx.answerCbQuery();
});

bot.action('noop', async (ctx) => {
    await ctx.answerCbQuery();
});

async function fetchAndShowPurchases(ctx) {
  try {
    const telegram_user_id = ctx.from.id.toString();

    const userRes = await fetch(`${process.env.API_URL || 'http://localhost:3001'}/users/by-telegram/${telegram_user_id}`);
    if (!userRes.ok) {
      return await ctx.reply('You are not registered. Please /start the bot first.');
    }
    const userData = await safeJsonParse(userRes);
    const userId = userData.id;

    const purchasesRes = await fetch(`${process.env.API_URL || 'http://localhost:3001'}/users/${userId}/purchases`);
    if (!purchasesRes.ok) {
      return await ctx.reply('❌ Failed to fetch your purchases.');
    }
    const purchases = await safeJsonParse(purchasesRes);

    ctx.session.orders = purchases.map(p => ({ ...p, type: 'purchase' }));
    ctx.session.orders_page = 0;
    ctx.session.orders_title = '🛍️ Your Purchases';

    await sendOrdersPage(ctx, ctx.session.orders_title);

  } catch (error) {
    logger.error('Error in fetchAndShowPurchases', { error: error.message, stack: error.stack, userId: ctx.session.user?.id });
    await ctx.reply('An error occurred while fetching your purchases.');
  }
}

async function fetchAndShowSales(ctx) {
  try {
    const telegram_user_id = ctx.from.id.toString();

    const userRes = await fetch(`${process.env.API_URL || 'http://localhost:3001'}/users/by-telegram/${telegram_user_id}`);
    if (!userRes.ok) {
      return await ctx.reply('You are not registered. Please /start the bot first.');
    }
    const userData = await safeJsonParse(userRes);
    const userId = userData.id;

    const salesRes = await fetch(`${process.env.API_URL || 'http://localhost:3001'}/users/${userId}/sales`);
    if (!salesRes.ok) {
      return await ctx.reply('❌ Failed to fetch your sales.');
    }
    const sales = await safeJsonParse(salesRes);

    ctx.session.orders = sales.map(s => ({ ...s, type: 'sale' }));
    ctx.session.orders_page = 0;
    ctx.session.orders_title = '💰 Your Sales';

    await sendOrdersPage(ctx, ctx.session.orders_title);

  } catch (error) {
    logger.error('Error in fetchAndShowSales', { error: error.message, stack: error.stack, userId: ctx.session.user?.id });
    await ctx.reply('An error occurred while fetching your sales.');
  }
}

bot.command('list_my_purchases', fetchAndShowPurchases);
bot.action('list_my_purchases', async (ctx) => {
  await ctx.answerCbQuery('Fetching your purchases...');
  await fetchAndShowPurchases(ctx);
});

bot.command('list_my_sales', fetchAndShowSales);
bot.action('list_my_sales', async (ctx) => {
  await ctx.answerCbQuery('Fetching your sales...');
  await fetchAndShowSales(ctx);
});

// Handle For Buying button
bot.hears('For Buying', (ctx) => {
  if (!MINI_APP_URL) {
    ctx.reply('Error: Mini app URL is not configured.');
    return;
  }
  
  const userSession = ctx.session.user;
  const userId = userSession ? userSession.id : '';
  
  ctx.reply('Please choose an option:', Markup.inlineKeyboard([
    [Markup.button.webApp('🔍 Search for accounts', `${MINI_APP_URL}/search-page?chat_id=${ctx.chat.id}&user_id=${userId}`)],
    [Markup.button.callback('🛍️ My Purchases', 'list_my_purchases')]
  ]));
});

// Handle For Selling button
bot.hears('For Selling', (ctx) => {
  if (!MINI_APP_URL) {
    ctx.reply('Error: Mini app URL is not configured.');
    return;
  }
  
  const userSession = ctx.session.user;
  const userId = userSession ? userSession.id : '';
  
  ctx.reply('Please choose an option:', Markup.inlineKeyboard([
    [Markup.button.webApp('📝 List New Account', `${MINI_APP_URL}/list-account?chat_id=${ctx.chat.id}&user_id=${userId}`)],
    [Markup.button.callback('💰 My Sales', 'list_my_sales')]
  ]));
});

bot.hears('Invite Friends', (ctx) => {
  const inviteLink = 'https://t.me/account_market_et_bot';
  const inviteMessage =
    `${escapeMarkdown('🎉 Invite your friends to join the Account Buying and Selling Bot using a link below!')}\n\n` +
    `👉 ${escapeMarkdown(inviteLink)}`
  ctx.reply(inviteMessage, { parse_mode: 'MarkdownV2', disable_web_page_preview: false });
});

// Handle Rules and guidelines button
bot.hears('📄 Rules and guidelines', (ctx) => {
  const rulesMessage = `📜 Rules and Guidelines\n\n` +
    `1. Do not pay directly to the seller outside the bot, communicating directly with the seller is allowed to access more information about the account but the order and payment for it should go through the bot, We will not be held liable for money lost not following this rule\n` +
    `2. Follow community guidelines and respect other users\n` +
    `3. Report any suspicious activity immediately\n` +
    `4. Prices are non-negotiable once listed\n\n` +
    `For more detailed information, please visit our Telegraph article: [Rules and Guidelines](https://telegra.ph/Rules-and-Guidelines-05-03)`;
  
  ctx.reply(rulesMessage, { parse_mode: 'Markdown' });
});


// Handle mark as sold callback
bot.action(/mark_sold_(.+)/, async (ctx) => {
  try {
    const accountId = ctx.match[1];
    const telegram_user_id = ctx.from.id.toString();
    
    // Get user ID from telegram user ID
    const userRes = await fetch(`${process.env.API_URL || 'http://localhost:3001'}/users/by-telegram/${telegram_user_id}`);
    if (!userRes.ok) {
      return await ctx.answerCbQuery('You are not registered. Please /start the bot first.', { show_alert: true });
    }
    
    const userData = await safeJsonParse(userRes);
    if (!userData) {
      return await ctx.answerCbQuery('Error fetching user data.', { show_alert: true });
    }
    
    const sellerId = userData.id;
    
    // Call the mark-as-sold endpoint
    const markSoldRes = await fetch(`${process.env.API_URL || 'http://localhost:3001'}/accounts/${accountId}/mark-as-sold`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seller_id: sellerId })
    });
    
    if (markSoldRes.ok) {
      await ctx.answerCbQuery('✅ Account marked as sold successfully!', { show_alert: true });
      
      // Send confirmation message
      await ctx.reply('Your account has been marked as sold and will no longer appear in search results.');
    } else {
      const errorData = await safeJsonParse(markSoldRes);
      const errorMessage = errorData?.error || 'Failed to mark account as sold';
      await ctx.answerCbQuery(errorMessage, { show_alert: true });
    }
  } catch (error) {
    logger.error('Error marking account as sold', { error: error.message, stack: error.stack });
    await ctx.answerCbQuery('An error occurred while marking the account as sold.', { show_alert: true });
  }
});

// Handle order button callback

bot.action(/initiate_transfer_(.+)/, async (ctx) => {
  try {
    const orderId = ctx.match[1];
    
    // Fetch order details to get buyer info
    const orderRes = await fetch(`${process.env.API_URL || `http://localhost:3001`}/orders/${orderId}`);
    if (!orderRes.ok) {
      const errorData = await safeJsonParse(orderRes);
      logger.error('Failed to fetch order details', { error: errorData });
      return ctx.answerCbQuery('Error: Could not fetch order details.', { show_alert: true });
    }

    const orderData = await safeJsonParse(orderRes);
    if (!orderData) {
      return ctx.answerCbQuery('Error: Could not parse order details.', { show_alert: true });
    }

    const { buyer, account } = orderData;

    const transferGuidelines = `⚠️ IMPORTANT: Account Transfer Guidelines ⚠️\n\n` +
      `You are about to transfer the account "${account.name}" to the buyer (@${buyer.username}). Please follow these steps carefully:\n\n` +
      `1. Contact the buyer directly through Telegram to coordinate the transfer.\n` +
      `2. Securely provide the account credentials to the buyer.\n` +
      `3. Ensure the buyer confirms they have full access to the account.\n` +
      `4. Once the transfer is complete and the buyer has confirmed access, click the "Transfer Complete" button below.\n\n` +
      `This action is final. Clicking "Transfer Complete" will mark the order as complete.`;

    await ctx.editMessageText(transferGuidelines, Markup.inlineKeyboard([
      Markup.button.callback('✅ Transfer Complete', `transfer_complete_${orderId}`)
    ]));

    await ctx.answerCbQuery();
  } catch (e) {
    logger.error('Error in initiate_transfer action', { error: e.message, stack: e.stack });
    await ctx.answerCbQuery('An unexpected error occurred.', { show_alert: true });
  }
});

bot.action(/transfer_complete_(.+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery('Processing completion...');
    const orderId = ctx.match[1];

    // 1. Update order status to 'completed'
    const updateRes = await fetch(`${process.env.API_URL || `http://localhost:3001`}/orders/${orderId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' })
    });

    if (!updateRes.ok) {
      const errorData = await safeJsonParse(updateRes);
      logger.error('Failed to update order status', { error: errorData });
      return ctx.answerCbQuery('Error: Could not update order status.', { show_alert: true });
    }


    // 2. Fetch order details to get seller ID from account owner
    const orderRes = await fetch(`${process.env.API_URL || `http://localhost:3001`}/orders/${orderId}`);
    if (!orderRes.ok) {
      logger.error('Failed to fetch order details after update');
      return;
    }
    const orderData = await safeJsonParse(orderRes);
    if (!orderData) {
      logger.error('Failed to parse order details after update');
      return;
    }
    const { buyer, account } = orderData;

    // 3. Credit seller's balance (account owner)
    const sellerId = account.owner_id;
    try {
      // Fetch seller's current balance
      const sellerRes = await fetch(`${process.env.API_URL || `http://localhost:3001`}/users/${sellerId}`);
      // console.log('sellerRes', sellerRes)
      if (!sellerRes.ok) {
        throw new Error('Failed to fetch seller data');
      }
      const sellerData = await safeJsonParse(sellerRes);
      const currentBalance = sellerData.balance || 0;
      const newBalance = currentBalance + account.price;  // Use account price instead of order amount
      logger.info('Crediting seller balance', { sellerId, amount: account.price, currentBalance, newBalance });
      // Update seller's balance - send only balance field
      const updateBalanceRes = await fetch(`${process.env.API_URL || `http://localhost:3001`}/users/${sellerId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ balance: newBalance })
      });

      if (!updateBalanceRes.ok) {
        throw new Error('Failed to update seller balance');
      }
      logger.info('Updated seller balance', { sellerId, newBalance });
    } catch (balanceError) {
      logger.error('Error crediting seller balance', { error: balanceError.message, stack: balanceError.stack });
      await ctx.reply(`⚠️ Account transfer completed but failed to credit seller's balance. Please contact support.`);
    }

    // 4. Notify seller
    await ctx.editMessageText('🎉 Transfer Complete! Your balance has been credited. Thank you for your business.');

    // 5. Notify buyer
    const buyerMessage = `🎉 The account "${account.name}" has been successfully transferred to you! The order is now complete.`;
    
    try {
      await bot.telegram.sendMessage(buyer.telegram_user_id, buyerMessage);
    } catch (e) {
      logger.error('Failed to send completion message to buyer', { buyerId: buyer.telegram_user_id, error: e.message, stack: e.stack });
      // Inform seller that buyer notification failed
      await ctx.followUp(`Could not send a notification to the buyer (@${buyer.username}). Please inform them of the completion manually.`);
    }
  } catch (e) {
    logger.error('Error in transfer_complete action', { error: e.message, stack: e.stack });
    await ctx.answerCbQuery('An unexpected error occurred.', { show_alert: true });
  }
});

// Add cancel order handler
bot.action(/cancel_order_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  try {
    await ctx.answerCbQuery('Cancelling order...');
    // Call DELETE endpoint
    const res = await fetch(`${process.env.API_URL || 'http://localhost:3001'}/orders/${orderId}/cancel`, {
      method: 'POST',
    });
    if (!res.ok) {
      const err = await safeJsonParse(res);
      await ctx.reply('❌ Failed to cancel order.' + (err?.error ? ` Reason: ${err.error}` : ''));
    } else {
      const reasonMessages = {
        order_refund: 'Refund processed due to order cancellation',
        seller_payout: 'Seller payout initiated - funds will be processed within 24 hours upto 7 days'
      };
      await ctx.reply(`✅ ${reasonMessages['order_refund']}`);
      // Refresh purchase list
      await fetchAndShowPurchases(ctx);
    }
  } catch (e) {
    logger.error('Error cancelling order', { error: e.message, stack: e.stack });
    await ctx.reply('❌ An error occurred while cancelling the order.');
  }
});


// Update the generic callback_query handler to allow other handlers to run if not handled
bot.on('callback_query', async (ctx, next) => {
  const callbackData = ctx.callbackQuery.data;
  if (!callbackData?.startsWith('order_account_')) {
    // Not handled here, let other handlers process it
    return next();
  }

  try {
    // Initialize session if it doesn't exist
    if (!ctx.session) {
      ctx.session = {};
    }
    ctx.answerCbQuery('Processing your order...');
    const accountId = callbackData.split('_')[2];

    // Get current user's data
    const telegram_user_id = ctx.from.id.toString();
    const userRes = await fetch(`${process.env.API_URL || 'http://localhost:3001'}/users/by-telegram/${telegram_user_id}`);
    if (!userRes.ok) {
      return await ctx.reply('Could not identify you. Please /start the bot.');
    }
    const userData = await safeJsonParse(userRes);

    // Attempt to reserve the account
    const reserveRes = await fetch(`${process.env.API_URL || 'http://localhost:3001'}/accounts/${accountId}/reserve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buyer_id: userData.id })
    });

    if (!reserveRes.ok) {
      const errorData = await safeJsonParse(reserveRes);
      await ctx.answerCbQuery(errorData.details || 'Sorry, this account is no longer available.', { show_alert: true });
      return await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n*This account has been reserved or sold.*', {
        parse_mode: 'Markdown'
      });
    }

    const { account } = await safeJsonParse(reserveRes);

    // Check if the buyer is the owner
    if (userData && userData.id === account.owner_id) {
      await ctx.reply('You cannot buy your own account.');
      return;
    }

    // Check if user already has an active order for this account
    const checkOrderRes = await fetch(
      `${process.env.API_URL || 'http://localhost:3001'}/orders/check?` + 
      new URLSearchParams({
        buyer_id: userData.id,
        account_id: accountId
      })
    );

    if (checkOrderRes.status === 400) {
      const errorData = await safeJsonParse(checkOrderRes);
      await ctx.answerCbQuery('Order exists!');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text + 
        '\n\n⚠️ ' + (errorData.error || 'You already have an active order for this account.') +
        '\n\nPlease check your orders list.'
      );
      return;
    } else if (!checkOrderRes.ok) {
      throw new Error('Failed to check existing orders');
    }

    // Store account ID in session for later use
    ctx.session.pendingAccountId = accountId;
    ctx.session.pendingAccountPrice = account.price;

    // Always show static escrow Telebirr account details
    const bankDetails =
      `Please make the payment of *${account.price.toLocaleString()} ETB* to one of the following escrow accounts:\n\n` +
      `*Option 1*\n` +
      `*Bank Name:* Telebirr\n` +
      `*Account Number:* 0907608839\n` +
      `*Account Name:* Kaleb Mate\n\n` +
      `*Option 2*\n` +
      `*Bank Name:* Commercial Bank of Ethiopia\n` +
      `*Account Name:* KALEB MATE MEGANE\n` +
      `*Account Number:* 1000308680658\n\n` +
      `After payment, please send the transaction receipt number to proceed with the order.`;

    await ctx.reply(bankDetails, { parse_mode: 'Markdown' });

    await ctx.reply(
      "Please choose your payment method:",
      Markup.inlineKeyboard([
        [Markup.button.callback('Pay with Telebirr', `pay_method_telebirr_${accountId}`)],
        [Markup.button.callback('Pay with CBE', `pay_method_cbe_${accountId}`)]
      ])
    );

    return;

    // The rest of the logic is now handled by the text handler below
  } catch (error) {
    logger.error('Error in order callback', { error: error.message, stack: error.stack });
    await ctx.answerCbQuery('An unexpected error occurred.', { show_alert: true });
  }
});

// Telebirr: ask for receipt number
bot.action(/pay_method_telebirr_(.+)/, async (ctx) => {
  const accountId = ctx.match[1];
  ctx.session.pendingAccountId = accountId;
  ctx.session.pendingPaymentMethod = 'telebirr';
  
  // Fetch account details to get the price
  try {
    const accountRes = await fetch(`${process.env.API_URL || 'http://localhost:3001'}/accounts/${accountId}`);
    if (accountRes.ok) {
      const accountData = await safeJsonParse(accountRes);
      if (accountData && accountData[0] && accountData[0].accounts) {
        ctx.session.pendingAccountPrice = accountData[0].accounts.price;
      }
    }
  } catch (error) {
    logger.error('Error fetching account price', { error: error.message, stack: error.stack });
  }
  
  await ctx.reply('Please enter your Telebirr receipt number:');
  await ctx.answerCbQuery();
});

// CBE: ask for image
bot.action(/pay_method_cbe_(.+)/, async (ctx) => {
  const accountId = ctx.match[1];
  ctx.session.pendingAccountId = accountId;
  ctx.session.pendingPaymentMethod = 'cbe';
  
  // Fetch account details to get the price
  try {
    const accountRes = await fetch(`${process.env.API_URL || 'http://localhost:3001'}/accounts/${accountId}`);
    if (accountRes.ok) {
      const accountData = await safeJsonParse(accountRes);
      if (accountData && accountData[0] && accountData[0].accounts) {
        ctx.session.pendingAccountPrice = accountData[0].accounts.price;
      }
    }
  } catch (error) {
    logger.error('Error fetching account price', { error: error.message, stack: error.stack });
  }
  
  await ctx.reply('Please upload a screenshot of your CBE payment receipt (as an image):');
  await ctx.answerCbQuery();
});

// Handle receipt number submission
bot.on('text', async (ctx) => {
  if (!ctx.session?.pendingAccountId || !ctx.message.text) return;

  const paymentMethod = ctx.session.pendingPaymentMethod;
  const accountId = ctx.session.pendingAccountId;
  const accountPrice = ctx.session.pendingAccountPrice;
  const receiptNo = ctx.message.text.trim();

  if (paymentMethod === 'telebirr') {
    try {
      await ctx.reply('🔍 Verifying your payment, please wait...');

      // 1. Verify payment with the external API
      const verificationResponse = await fetch(`${process.env.API_URL || 'http://localhost:3001'}/orders/verify-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference: receiptNo, amount: accountPrice })
      });

      if (!verificationResponse.ok) {
        const errorData = await safeJsonParse(verificationResponse);
        return ctx.reply(`❌ Payment verification failed: ${errorData.error || 'Unknown error'}`);
      }

      // 2. Get user data
      const telegram_user_id = ctx.from.id.toString();
      const username = ctx.from.username || '';
      const userRes = await fetch(`${process.env.API_URL || 'http://localhost:3001'}/users/by-telegram/${telegram_user_id}`);
      if (!userRes.ok) throw new Error('Failed to get user data');
      const userData = await safeJsonParse(userRes);
      if (!userData?.id) throw new Error('User data not available');

      // 3. Create the order
      const orderResponse = await fetch(`${process.env.API_URL || 'http://localhost:3001'}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          buyer_id: userData.id,
          account_id: accountId,
          amount: accountPrice,
          receipt_no: receiptNo
        })
      });

      if (!orderResponse.ok) {
        const errorData = await safeJsonParse(orderResponse);
        throw new Error(errorData.error || 'Failed to create order');
      }

      const order = await safeJsonParse(orderResponse);

      // 4. Clean up session and notify user
      delete ctx.session.pendingAccountId;
      delete ctx.session.pendingAccountPrice;

      await ctx.reply(`✅ Payment verified and order created successfully!\nOrder ID: ${order.id}`);

    } catch (error) {
      logger.error('Error processing receipt', { error: error.message, stack: error.stack });
      await ctx.reply(`❌ An error occurred: ${error.message}`);
      // Clear session on error
      delete ctx.session.pendingAccountId;
      delete ctx.session.pendingAccountPrice;
    }
  }
});

// New handler for CBE payment screenshot
bot.on('photo', async (ctx) => {
  if (!ctx.session?.pendingAccountId || ctx.session.pendingPaymentMethod !== 'cbe') return;

  const accountId = ctx.session.pendingAccountId;
  const accountPrice = ctx.session.pendingAccountPrice;
  logger.debug("Account price retrieved", { accountPrice })
  await ctx.reply('🔍 Verifying your CBE payment, please wait...');

  try {
    // Get the highest resolution photo
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileId = photo.file_id;
    const fileUrl = await ctx.telegram.getFileLink(fileId);

    // Upload image to Cloudinary
    const response = await fetch(fileUrl.href);
    const buffer = await response.arrayBuffer();
    const cloudinaryUrl = await cloudinaryUploader(Buffer.from(buffer));

    // Verify payment using new API
    logger.debug("CBE verification URL", { url: `${process.env.CBE_VERIFIER_URL}/parse?image_url=${cloudinaryUrl}` })
    const verifyRes = await fetch(`${process.env.CBE_VERIFIER_URL}/parse?image_url=${cloudinaryUrl}`);
    // const verifyRes = await fetch(`${process.env.CBE_VERIFIER_URL}/parse?image_url=${encodeURIComponent(cloudinaryUrl)}`);
    if (!verifyRes.ok) {
      logger.error('Failed to verify payment', { status: verifyRes.status, statusText: verifyRes.statusText });
      // Delete the uploaded image even on verification failure
      try {
        await deleteFromCloudinary(cloudinaryUrl);
        logger.debug('Deleted failed verification image from Cloudinary', { cloudinaryUrl });
      } catch (deleteError) {
        logger.error('Failed to delete image from Cloudinary', { error: deleteError.message, stack: deleteError.stack });
      }
      throw new Error('Failed to verify payment');
    }

    const verificationData = await verifyRes.json();
    logger.debug("CBE verification data received", { verificationData })
    if (!verificationData.success) {
      // Delete the uploaded image even on verification failure
      try {
        await deleteFromCloudinary(cloudinaryUrl);
        logger.debug('Deleted failed verification image from Cloudinary', { cloudinaryUrl });
      } catch (deleteError) {
        logger.error('Failed to delete image from Cloudinary', { error: deleteError.message, stack: deleteError.stack });
      }
      
      if (verificationData.message === "transaction already exist") {
        return ctx.reply('❌ This transaction receipt has already been used. Please use a new receipt.');
      }
      return ctx.reply('❌ Payment verification failed. Please check your receipt and try again.');
    }

    // Get user data
    const telegram_user_id = ctx.from.id.toString();
    const userRes = await fetch(`${process.env.API_URL || 'http://localhost:3001'}/users/by-telegram/${telegram_user_id}`);
    if (!userRes.ok) throw new Error('Failed to get user data');
    const userData = await safeJsonParse(userRes);
    if (!userData?.id) throw new Error('User data not available');

    // Validate receiver name
    const validReceivers = ['Kaleb Mate', 'KALEB MATE MEGANE'];
    const normalizedReceiver = verificationData.data.receiver.trim().toUpperCase();
    const isValidReceiver = validReceivers.some(name => 
      name.toUpperCase() === normalizedReceiver
    );
    
    if (!isValidReceiver) {
      throw new Error(`The receiver name '${verificationData.data.receiver}' does not match any escrow account`);
    }

    // Validate amount matches account price
    const amount = parseInt(verificationData.data.amount);
    if (amount !== accountPrice) {
      try {
        await deleteFromCloudinary(cloudinaryUrl);
        logger.debug('Deleted image from Cloudinary', { cloudinaryUrl });
      } catch (deleteError) {
        logger.error('Failed to delete image from Cloudinary', { error: deleteError.message, stack: deleteError.stack });
      }
      throw new Error(`Amount ${amount} ETB does not match required price ${accountPrice} ETB`);
    }

    // Create the order
    const orderResponse = await fetch(`${process.env.API_URL || 'http://localhost:3001'}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        buyer_id: userData.id,
        account_id: accountId,
        amount: amount,
        receipt_no: verificationData.data.transaction,
      })
    });

    if (!orderResponse.ok) {
      const errorData = await safeJsonParse(orderResponse);
      throw new Error(errorData.error || 'Failed to create order');
    }

    const order = await safeJsonParse(orderResponse);

    // Save transaction record after successful order creation
    logger.debug("Transaction verification data", { verificationData })
    try {
      const saveTransactionResponse = await fetch(`${process.env.CBE_VERIFIER_URL}/save-transaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transactionNumber: verificationData.data.transactionNumber,
          amount: amount,
          receiver: verificationData.data.receiver,
        })
      });

      if (!saveTransactionResponse.ok) {
        logger.error('Failed to save transaction record', { response: await saveTransactionResponse.text() });
        // Don't fail the order if transaction saving fails, just log it
      }
    } catch (saveError) {
      logger.error('Error saving transaction record', { error: saveError.message, stack: saveError.stack });
      // Don't fail the order if transaction saving fails
    }

    await ctx.reply('✅ CBE payment verified and order created successfully!');
    
    // Delete the uploaded image from Cloudinary
    try {
      await deleteFromCloudinary(cloudinaryUrl);
      logger.debug('Successfully deleted image from Cloudinary', { cloudinaryUrl });
    } catch (deleteError) {
      logger.error('Failed to delete image from Cloudinary', { error: deleteError.message, stack: deleteError.stack });
      // Don't fail the order if deletion fails, just log it
    }
    
    delete ctx.session.pendingAccountId;
    delete ctx.session.pendingPaymentMethod;
    delete ctx.session.pendingAccountPrice;

  } catch (error) {
    logger.error('Error verifying CBE payment', { error: error.message, stack: error.stack });
    await ctx.reply(`❌ An error occurred: ${error.message}`);
    // Clean up session
    delete ctx.session.pendingAccountId;
    delete ctx.session.pendingPaymentMethod;
    delete ctx.session.pendingAccountPrice;
  }
});

// Generic error handler
bot.catch((err, ctx) => {
  logger.error(`Ooops, encountered an error for ${ctx.updateType}`, { error: err.message, stack: err.stack, context: ctx });
  // Handle specific Telegram errors
  if (err instanceof require('telegraf').TelegramError) {
    if (err.code === 403) {
      logger.warn('Bot was blocked or kicked from a group.', { chatId: ctx.chat?.id });
      // Optionally, you can remove the user/chat from your database
    } else if (err.code === 400) {
      logger.warn('Bad request error, possibly malformed message.', { description: err.description, chatId: ctx.chat?.id });
    } else {
      logger.error('Unhandled Telegram error', { errorCode: err.code, description: err.description });
    }
  } else {
    logger.error('Non-Telegram error occurred', { error: err.toString() });
  }

  // Notify user if possible
  try {
    if (err.code !== 403) {
        ctx.reply('An unexpected error occurred. Please try again later.');
    }
  } catch (e) {
    logger.error('Failed to send error message to user', { error: e.message, chatId: ctx.chat?.id });
  }
});

// Add this new handler for delete account confirmation
bot.action(/delete_account_(.+)/, async (ctx) => {
  try {
    const accountId = ctx.match[1];
    
    // Fetch account details to verify ownership
    const accountRes = await fetch(`${process.env.API_URL || `http://localhost:3001`}/accounts/${accountId}`);
    if (!accountRes.ok) {
      return ctx.answerCbQuery('Error: Could not fetch account details.', { show_alert: true });
    }

    const accountData = await safeJsonParse(accountRes);
    if (!accountData || !accountData[0]) {
      return ctx.answerCbQuery('Error: Account not found.', { show_alert: true });
    }

    const account = accountData[0].accounts;
    const owner = accountData[0].users;

    // Verify the user is the owner
    const telegram_user_id = ctx.from.id.toString();
    if (owner.telegram_user_id !== telegram_user_id) {
      return ctx.answerCbQuery('Error: You can only delete your own accounts.', { show_alert: true });
    }

    // No need to check for pending orders, just confirm deletion
    const confirmationMessage = `⚠️ DELETE ACCOUNT CONFIRMATION ⚠️\n\n` +
      `Are you sure you want to delete "${account.name}"?\n\n` +
      `This action cannot be undone. The account and any associated orders will be permanently removed from the marketplace. Buyers will be refunded automatically.`;

    await ctx.editMessageText(confirmationMessage, Markup.inlineKeyboard([
      [
        Markup.button.callback('❌ Cancel', 'cancel_delete'),
        Markup.button.callback('🗑️ Confirm Delete', `confirm_delete_${accountId}`)
      ]
    ]));

    await ctx.answerCbQuery();
  } catch (e) {
    logger.error('Error in delete_account action', { error: e.message, stack: e.stack });
    await ctx.answerCbQuery('An unexpected error occurred.', { show_alert: true });
  }
});

// Handle cancel delete
bot.action('cancel_delete', async (ctx) => {
  await ctx.editMessageText('❌ Account deletion cancelled.');
  await ctx.answerCbQuery('Deletion cancelled');
});

// Handle confirm delete
bot.action(/confirm_delete_(.+)/, async (ctx) => {
  try {
    const accountId = ctx.match[1];
    
    // Delete the account and get affected orders (buyers to notify)
    const deleteRes = await fetch(`${process.env.API_URL || `http://localhost:3001`}/accounts/${accountId}`, {
      method: 'DELETE'
    });

    if (!deleteRes.ok) {
      const errorData = await safeJsonParse(deleteRes);
      logger.error("Failed to delete account", { errorData });
      await ctx.editMessageText('❌ Failed to delete account. Please try again later.');
      return ctx.answerCbQuery('Delete failed', { show_alert: true });
    }

    // Expect backend to return { affectedOrders: [{ buyer: { telegram_user_id, username }, account: { name } }, ...] }
    const result = await safeJsonParse(deleteRes);
    const affectedOrders = result?.affectedOrders || [];

    // Notify each buyer
    for (const { buyer, account } of affectedOrders) {
      if (buyer?.telegram_user_id && account?.name) {
        const msg = `❗️ The order you placed for "${account.name}" was removed by the seller.\nYou will be refunded within 24 hours up to 7 days.`;
        try {
          await ctx.telegram.sendMessage(buyer.telegram_user_id, msg);
        } catch (e) {
          logger.error('Failed to notify buyer', { buyerId: buyer.telegram_user_id, error: e.message, stack: e.stack });
        }
      }
    }

    await ctx.editMessageText('✅ Account successfully deleted from the marketplace. All buyers have been notified and will be refunded.');
    await ctx.answerCbQuery('Account deleted successfully');

  } catch (e) {
    logger.error('Error in confirm_delete action', { error: e.message, stack: e.stack });
    await ctx.editMessageText('❌ An error occurred while deleting the account.', { show_alert: true });
    await ctx.answerCbQuery('An unexpected error occurred.', { show_alert: true });
  }
});


// Withdraw balance action
bot.action('withdraw_balance', async (ctx) => {
    await ctx.answerCbQuery('Processing withdrawal...');
    const { user } = ctx.session;
    
    if (!user || !user.id) {
        return ctx.reply('You are not logged in. Please use /start to log in.');
    }

    try {
        const apiUrl = process.env.API_URL || 'http://localhost:3001';
        const response = await fetch(`${apiUrl}/users/${user.id}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (response.ok) {
            const userData = await response.json();
            
            // Check if balance is sufficient
            if (userData.balance < 100) {
                return ctx.reply(`❌ Minimum withdrawal threshold is 100 ETB. Your current balance is ${userData.balance} ETB.`);
            }
            
            // Create withdrawal record
            const withdrawalRes = await fetch(`${apiUrl}/withdrawals`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: user.id,
                    amount: userData.balance,
                    reason: 'seller_payout'
                })
            });
            
            if (withdrawalRes.ok) {
                const withdrawal = await withdrawalRes.json();
                logger.info('Withdrawal created', { withdrawalId: withdrawal.id, amount: withdrawal.amount, userId: user.id });
                const reasonMessages = {
                  order_refund: 'Refund processed due to order cancellation',
                  seller_payout: 'Seller payout initiated - funds will be processed within 24 hours'
                };
                await ctx.reply(`✅ ${reasonMessages[withdrawal.reason] || 'Funds will be sent to your bank account within 24 hours'}`);
            } else {
                const errorData = await withdrawalRes.json();
                ctx.reply(`❌ Failed to process withdrawal: ${errorData.error || 'Unknown error'}`);
            }
        } else {
            ctx.reply('Failed to fetch your balance. Please try again later.');
        }
    } catch (error) {
        logger.error('Error processing withdrawal', { error: error.message, stack: error.stack });
        ctx.reply('An error occurred while processing your withdrawal.');
    }
});



// Start the bot, uncomment this on dev mode
bot.launch()
  .then(() => {
    logger.info('Bot started successfully');
    if (!MINI_APP_URL) {
      logger.warn('MINI_APP_URL is not configured in environment variables');
    }
  })
  .catch((err) => {
    logger.error('Error starting bot', { error: err.message, stack: err.stack });
  });

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

module.exports = { bot };

