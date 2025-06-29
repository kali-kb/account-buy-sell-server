const { Telegraf, Markup, session } = require('telegraf');
const dotenv = require('dotenv');

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const MINI_APP_URL = process.env.MINI_APP_URL;
const REQUIRE_PAYMENT_SCREENSHOT = false; // Flag to toggle payment screenshot verification
bot.use(session());

// Welcome message and main keyboard
const getMainKeyboard = () => {
  return Markup.keyboard([
    ['For Buying', 'For Selling'],
    ['📄 Rules and guidelines']
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
    console.error('JSON parse error:', error, 'Response text:', text);
    return null;
  }
};

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
            console.log('User exists:', userData);
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
                console.log('User created:', userData);
            }
        } else {
            const err = await safeJsonParse(createRes);
            console.error('Failed to create user:', err);
            // Check for specific username error from backend
            if (createRes.status === 400 && err?.error?.includes("Username is required")) {
                await ctx.reply('Welcome! To use this bot, you must have a public Telegram username. Please set one in your Telegram settings and then type /start again.');
                return; // Stop processing and don't show the main keyboard
            }
        }
    } else {
        // Handle other HTTP errors
        const err = await safeJsonParse(res);
        console.error('Failed to fetch user:', err);
    }
  } catch (e) {
    console.error('Error creating or fetching user on start:', e);
  }

  // Initialize session if it doesn't exist
  if (!ctx.session) {
    ctx.session = {};
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

  ctx.reply(welcomeMessage, getMainKeyboard());
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
    console.error('Error fetching balance:', error);
    ctx.reply('An error occurred while fetching your balance.');
  }
});

const ITEMS_PER_PAGE = 5;

async function sendOrdersPage(ctx, title = '📄 Your Orders', edit = false) {
  const { orders, orders_page = 0 } = ctx.session;

  if (!orders || orders.length === 0) {
    const text = 'You have no orders yet.';
    if (edit) {
      try {
        return await ctx.editMessageText(text, { reply_markup: { inline_keyboard: [] } });
      } catch (e) {
        if (!e.message.includes('message is not modified')) console.error(e);
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

    let orderInfo = `🧾 *Account:* ${account.name}\n`;
    if (isSale) {
      orderInfo += `👤 *Buyer:* @${user.username}\n`;
    } else {
      const sellerUsername = seller ? seller.username : 'N/A';
      orderInfo += `👤 *Seller:* @${sellerUsername}\n`;
    }
    orderInfo += `💰 *Amount:* ${order.amount} ETB\n`;
    orderInfo += `💳 *Status:* ${order.status}\n`;
    orderInfo += `📅 *Date:* ${date}`;

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
    console.error('Error in fetchAndShowPurchases:', error);
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
    console.error('Error in fetchAndShowSales:', error);
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

// Handle order button callback

bot.action(/initiate_transfer_(.+)/, async (ctx) => {
  try {
    const orderId = ctx.match[1];
    
    // Fetch order details to get buyer info
    const orderRes = await fetch(`${process.env.API_URL || `http://localhost:3001`}/orders/${orderId}`);
    if (!orderRes.ok) {
      const errorData = await safeJsonParse(orderRes);
      console.error("Failed to fetch order details:", errorData);
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
    console.error('Error in initiate_transfer action:', e);
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
      console.error("Failed to update order status:", errorData);
      return ctx.answerCbQuery('Error: Could not update order status.', { show_alert: true });
    }


    // 2. Fetch order details to get seller ID from account owner
    const orderRes = await fetch(`${process.env.API_URL || `http://localhost:3001`}/orders/${orderId}`);
    if (!orderRes.ok) {
      console.error('Failed to fetch order details after update');
      return;
    }
    const orderData = await safeJsonParse(orderRes);
    if (!orderData) {
      console.error('Failed to parse order details after update');
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
      console.log(`Crediting seller ${sellerId} with amount ${account.price}. Current balance: ${currentBalance}, New balance: ${newBalance}`);
      // Update seller's balance - send only balance field
      const updateBalanceRes = await fetch(`${process.env.API_URL || `http://localhost:3001`}/users/${sellerId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ balance: newBalance })
      });

      if (!updateBalanceRes.ok) {
        throw new Error('Failed to update seller balance');
      }
      // Log successful update
      console.log(`Updated seller ${sellerId} balance to ${newBalance}`);
    } catch (balanceError) {
      console.error('Error crediting seller balance:', balanceError);
      await ctx.reply(`⚠️ Account transfer completed but failed to credit seller's balance. Please contact support.`);
    }

    // 4. Notify seller
    await ctx.editMessageText('🎉 Transfer Complete! The Your balance has been credited. Thank you for your business.');

    // 5. Notify buyer
    const buyerMessage = `🎉 The account "${account.name}" has been successfully transferred to you! The order is now complete.`;
    
    try {
      await bot.telegram.sendMessage(buyer.telegram_user_id, buyerMessage);
    } catch (e) {
      console.error(`Failed to send completion message to buyer ${buyer.telegram_user_id}`, e);
      // Inform seller that buyer notification failed
      await ctx.followUp(`Could not send a notification to the buyer (@${buyer.username}). Please inform them of the completion manually.`);
    }
  } catch (e) {
    console.error('Error in transfer_complete action:', e);
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
      await ctx.reply('✅ Order cancelled successfully.');
      // Refresh purchase list
      await fetchAndShowPurchases(ctx);
    }
  } catch (e) {
    console.error('Error cancelling order:', e);
    await ctx.reply('❌ An error occurred while cancelling the order.');
  }
});

// Handle Delete Account inline button
bot.action(/delete_account_(.+)/, async (ctx) => {
  const accountId = ctx.match[1];
  try {
    await ctx.answerCbQuery('Deleting account...');
    // Call backend to delete the account
    const res = await fetch(`${process.env.API_URL || 'http://localhost:3001'}/accounts/${accountId}`, {
      method: 'DELETE',
    });
    const data = await safeJsonParse(res);
    if (!res.ok) {
      // Show error from backend (e.g., pending orders)
      const errorMsg = data && data.error ? data.error : 'Failed to delete account.';
      await ctx.reply(`❌ ${errorMsg}`);
      return;
    }
    // Success
    await ctx.editMessageText('✅ Account deleted successfully.');
  } catch (e) {
    console.error('Error deleting account:', e);
    await ctx.reply('❌ An error occurred while deleting the account.');
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
        `Please make the payment of *${account.price.toLocaleString()} ETB* to the following escrow account:\n\n` +
        `*Bank Name:* Telebirr\n` +
        `*Account Number:* 0907608839\n` +
        `*Account Name:* Kaleb Mate\n\n` +
        `After payment, please send the transaction receipt number to proceed with the order.`;

    await ctx.reply(bankDetails, { parse_mode: 'Markdown' });
    return;

    // The rest of the logic is now handled by the text handler below
  } catch (error) {
    console.error('Error in order callback:', error);
    await ctx.answerCbQuery('An unexpected error occurred.', { show_alert: true });
  }
});

// Handle receipt number submission
bot.on('text', async (ctx) => {
  if (!ctx.session?.pendingAccountId || !ctx.message.text) {
    return;
  }

  const receiptNo = ctx.message.text.trim();
  const accountId = ctx.session.pendingAccountId;
  const accountPrice = ctx.session.pendingAccountPrice;

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
    console.error('Error processing receipt:', error);
    await ctx.reply(`❌ An error occurred: ${error.message}`);
    // Clear session on error
    delete ctx.session.pendingAccountId;
    delete ctx.session.pendingAccountPrice;
  }
});

// Error handling
bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType}:`, err);
  ctx.reply('An error occurred while processing your request.');
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

    // Check if there are any pending orders for this account
    const ordersRes = await fetch(`${process.env.API_URL || `http://localhost:3001`}/accounts/${accountId}/orders`);
    if (ordersRes.ok) {
      const orders = await safeJsonParse(ordersRes);
      if (orders && orders.length > 0) {
        const pendingOrders = orders.filter(order => order.status === 'pending' || order.status === 'in_progress');
        if (pendingOrders.length > 0) {
          return ctx.answerCbQuery('Cannot delete account with pending orders. Please complete or cancel all orders first.', { show_alert: true });
        }
      }
    }

    const confirmationMessage = `⚠️ DELETE ACCOUNT CONFIRMATION ⚠️\n\n` +
      `Are you sure you want to delete "${account.name}"?\n\n` +
      `This action cannot be undone. The account will be permanently removed from the marketplace.`;

    await ctx.editMessageText(confirmationMessage, Markup.inlineKeyboard([
      [
        Markup.button.callback('❌ Cancel', 'cancel_delete'),
        Markup.button.callback('🗑️ Confirm Delete', `confirm_delete_${accountId}`)
      ]
    ]));

    await ctx.answerCbQuery();
  } catch (e) {
    console.error('Error in delete_account action:', e);
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
    
    // Delete the account
    const deleteRes = await fetch(`${process.env.API_URL || `http://localhost:3001`}/accounts/${accountId}`, {
      method: 'DELETE'
    });

    if (!deleteRes.ok) {
      const errorData = await safeJsonParse(deleteRes);
      console.error("Failed to delete account:", errorData);
      await ctx.editMessageText('❌ Failed to delete account. Please try again later.');
      return ctx.answerCbQuery('Delete failed', { show_alert: true });
    }

    await ctx.editMessageText('✅ Account successfully deleted from the marketplace.');
    await ctx.answerCbQuery('Account deleted successfully');

  } catch (e) {
    console.error('Error in confirm_delete action:', e);
    await ctx.editMessageText('❌ An error occurred while deleting the account.', { show_alert: true });
    await ctx.answerCbQuery('An unexpected error occurred.', { show_alert: true });
  }
});

// Handle Delete Account inline button
bot.action(/delete_account_(.+)/, async (ctx) => {
  const accountId = ctx.match[1];
  try {
    await ctx.answerCbQuery('Deleting account...');
    // Call backend to delete the account
    const res = await fetch(`${process.env.API_URL || 'http://localhost:3001'}/accounts/${accountId}`, {
      method: 'DELETE',
    });
    const data = await safeJsonParse(res);
    if (!res.ok) {
      // Show error from backend (e.g., pending orders)
      const errorMsg = data && data.error ? data.error : 'Failed to delete account.';
      await ctx.reply(`❌ ${errorMsg}`);
      return;
    }
    // Success
    await ctx.editMessageText('✅ Account deleted successfully.');
  } catch (e) {
    console.error('Error deleting account:', e);
    await ctx.reply('❌ An error occurred while deleting the account.');
  }
});

// Withdraw balance action
bot.action('withdraw_balance', async (ctx) => {
  ctx.answerCbQuery('Processing withdrawal request...');
  try {
    const { user } = ctx.session;
    if (!user || !user.id) {
      return ctx.reply('You are not logged in. Please use /start to log in.');
    }
    const apiUrl = process.env.API_URL || 'http://localhost:3001';
    const response = await fetch(`${apiUrl}/users/${user.id}`);
    if (!response.ok) {
      return ctx.reply('Failed to fetch balance. Please try again later.');
    }
    const userData = await response.json();
    if (userData.balance < 100) {
      return ctx.reply('❌ Not enough funds to withdraw. Minimum is 100 ETB.');
    }
    // Here you can implement your withdrawal logic (e.g., ask for withdrawal details, process payout, etc.)
    return ctx.reply('✅ Withdrawal initiated! Our team will process your request soon.');
  } catch (error) {
    console.error('Error handling withdrawal:', error);
    ctx.reply('An error occurred while processing your withdrawal.');
  }
});



// Start the bot
bot.launch()
  .then(() => {
    console.log('Bot started successfully');
    if (!MINI_APP_URL) {
      console.warn('Warning: MINI_APP_URL is not configured in environment variables');
    }
  })
  .catch((err) => {
    console.error('Error starting bot:', err);
  });

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

module.exports = { bot };

process.once('SIGTERM', () => bot.stop('SIGTERM'));

module.exports = { bot };

