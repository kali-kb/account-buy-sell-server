require("dotenv").config();
const express = require("express");
const { bot } = require("./bot");
const { Pool } = require("pg");
const cors = require("cors");
const { drizzle } = require("drizzle-orm/node-postgres");
const { alias } = require("drizzle-orm/pg-core");
const { eq, like, ilike, gte, lte, and, or, sql, desc } = require("drizzle-orm");
const { accounts, users, orders, transfers } = require("./db/schema");

const app = express();
const PORT = process.env.PORT || 3001;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const corsOptions = {
  origin: "*",
  credentials: true
};

const db = drizzle(pool);

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Middleware
app.use(express.json());
app.use(cors(corsOptions));

// Basic route
app.get("/", (req, res) => {
  console.log("executed")
  res.json({ message: "Server is running!" });
});


app.post('/users', async (req, res) => {
  try {
    const { telegram_user_id, username } = req.body;
    const existing = await db.select().from(users).where(eq(users.telegram_user_id, telegram_user_id));
    if (existing.length === 0) {
      // create user
      const result = await db.insert(users).values({
        telegram_user_id,
        username,
      }).returning();
      res.json(result[0]);
    } else {
      // return existing user
      res.json(existing[0]);
    }
  } catch (error) {
    console.error("Error creating user:", error);
    res.status(500).json({ error: "Failed to create user" });
  }
})

app.get('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.select().from(users).where(eq(users.id, id));
    res.json(result[0]);
  } catch (error) {
    console.error("Error fetching user:", error);
    res.status(500).json({ error: "Failed to fetch user" });
  }
})

app.put('/users/:id/bank-details', async (req, res) => {
  try {
    const { id } = req.params;
    const { account_holder_name, bank_name, account_number } = req.body;

    if (!account_holder_name || !bank_name || !account_number) {
      return res.status(400).json({ error: "Bank account details are required" });
    }

    const result = await db.update(users).set({
      account_holder_name,
      bank_name,
      account_number,
    }).where(eq(users.id, id)).returning();

    if (result.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json(result[0]);
  } catch (error) {
    console.error("Error updating bank details:", error);
    res.status(500).json({ error: "Failed to update bank details" });
  }
});

app.get('/users/:id/purchases', async (req, res) => {
  try {
    const { id } = req.params;
    const seller = alias(users, 'seller');
    const result = await db
      .select({
        order: orders,
        account: accounts,
        user: users, // This is the buyer
        seller: seller
      })
      .from(orders)
      .innerJoin(accounts, eq(orders.account_id, accounts.id))
      .innerJoin(users, eq(orders.buyer_id, users.id))
      .innerJoin(seller, eq(accounts.owner_id, seller.id))
      .where(eq(orders.buyer_id, id));
    
    const formattedResult = result.map(p => ({ order: p.order, account: p.account, user: p.user, seller: p.seller }));
    res.json(formattedResult);
  } catch (error) {
    console.error("Error fetching purchases:", error);
    res.status(500).json({ error: "Failed to fetch purchases" });
  }
})

app.get('/users/:id/sales', async (req, res) => {
  try {
    const { id } = req.params;
    // First get all orders for accounts owned by this user
    const result = await db
      .select()
      .from(orders)
      .innerJoin(accounts, eq(orders.account_id, accounts.id))
      .innerJoin(users, eq(orders.buyer_id, users.id))
      .where(eq(accounts.owner_id, id));
    const formattedResult = result.map(s => ({ order: s.orders, account: s.accounts, user: s.users }));
    res.json(formattedResult);
  } catch (error) {
    console.error("Error fetching sales:", error);
    res.status(500).json({ error: "Failed to fetch sales" });
  }
})


app.get('/accounts', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 6;
    const offset = (page - 1) * limit;

    console.log(`[ACCOUNTS] Fetching page ${page}, limit ${limit}, offset ${offset}`);

    // Get total count for pagination info
    const totalCountResult = await db.select({ count: sql`count(*)` }).from(accounts);
    const totalCount = parseInt(totalCountResult[0].count);
    
    // Get paginated results with consistent ordering
    const result = await db.select().from(accounts)
      .orderBy(desc(accounts.created_at), accounts.id) // Added secondary sort for consistency
      .limit(limit)
      .offset(offset);
    
    const totalPages = Math.ceil(totalCount / limit);
    const hasMore = page < totalPages;
    
    console.log(`[ACCOUNTS] Found ${result.length} accounts on page ${page}/${totalPages}. Total: ${totalCount}, HasMore: ${hasMore}`);
    
    const response = {
      accounts: result,
      pagination: {
        currentPage: page,
        totalPages,
        totalCount,
        hasMore,
        limit,
        offset
      }
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching accounts:", error);
    res.status(500).json({ error: "Failed to fetch accounts" });
  }
})


// listing account
app.post("/accounts", async (req, res) => {
  console.log("Received request body:", req.body)
  try {
    const { 
      // Account details
      owner_id, 
      platform_type, 
      name, 
      url, 
      price, 
      subscriber_count, 
      creation_year, 
      is_monetized,
      // Bank account details
      account_holder_name,
      bank_name,
      account_number
    } = req.body;

    if (!account_holder_name || !bank_name || !account_number) {
      return res.status(400).json({ error: "Bank account details are required" });
    }

    // Start a transaction
    const result = await db.transaction(async (tx) => {
      // Create the account first
      const accountResult = await tx.insert(accounts).values({
        owner_id,
        platform: platform_type,
        name,
        url,
        price,
        subscriber_count,
        creation_year,
        is_monetized,
      }).returning();

      // Then, update the user's bank account details
      const userResult = await tx.update(users).set({
        account_holder_name,
        bank_name,
        account_number,
      }).where(eq(users.id, owner_id)).returning();

      // Return both results
      if (!accountResult[0] || !userResult[0]) {
        throw new Error("Failed to create account or update user bank details");
      }

      return {
        account: accountResult[0],
        user: userResult[0]
      };
    });

    console.log("Transaction completed successfully:", result);
    res.json(result);
  } catch (error) {
    console.error("Error in transaction:", error);
    res.status(500).json({ 
      error: "Failed to create account and bank details", 
      message: error.message,
      details: error.detail || error.toString()
    });
  }
});


// app.get("/search/account", async (req, res) => {
//   try {
//     const { query } = req.query;
//     const result = await db.select().from(accounts).where(like(accounts.name, `%${query}%`));
//     res.json(result);
//   } catch (error) {
//     console.error("Error searching accounts:", error);
//     res.status(500).json({ error: "Failed to search accounts" });
//   }
// })


//will come to this later
app.get("/search/accounts", async (req, res) => {
  try {
    const { query, platform_type, minSubscribers, maxSubscribers, isMonetized, page = 1, limit = 6 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    console.log(`[SEARCH] Query: ${query}, Platform: ${platform_type}, Page: ${page}`);
    
    let filteredAccounts = db.select().from(accounts);
    let conditions = [];
    
    if (query) {
      conditions.push(ilike(accounts.name, `%${query}%`));
    }
    if (platform_type) {
      const normalizedPlatform = platform_type.toLowerCase();
      conditions.push(ilike(accounts.platform, normalizedPlatform));
    }
    if (minSubscribers) {
      conditions.push(gte(accounts.subscriber_count, parseInt(minSubscribers)));
    }
    if (maxSubscribers) {
      conditions.push(lte(accounts.subscriber_count, parseInt(maxSubscribers)));
    }
    if (isMonetized) {
      conditions.push(eq(accounts.is_monetized, isMonetized === 'true'));
    }

    if (conditions.length > 0) {
      filteredAccounts = filteredAccounts.where(and(...conditions));
    }

    // Get total count for pagination
    const totalCountQuery = db.select({ count: sql`count(*)` }).from(accounts);
    if (conditions.length > 0) {
      totalCountQuery.where(and(...conditions));
    }
    const totalCountResult = await totalCountQuery;
    const totalCount = parseInt(totalCountResult[0].count);

    // Get paginated results
    const results = await filteredAccounts
      .orderBy(desc(accounts.created_at), accounts.id)
      .limit(parseInt(limit))
      .offset(offset);

    const totalPages = Math.ceil(totalCount / parseInt(limit));
    const hasMore = parseInt(page) < totalPages;

    console.log(`[SEARCH] Found ${results.length} results on page ${page}/${totalPages}`);

    res.json({
      accounts: results,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCount,
        hasMore,
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    console.error("Error searching accounts:", error);
    res.status(500).json({ error: "Failed to search accounts" });
  }
});


app.get("/accounts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.select().from(accounts).where(eq(accounts.id, id)).innerJoin(users, eq(accounts.owner_id, users.id));
    res.json(result);
  } catch (error) {
    console.error("Error fetching account:", error);
    res.status(500).json({ error: "Failed to fetch account" });
  }
});

// Check if user already has an active order for an account
app.get("/orders/check", async (req, res) => {
  try {
    const { buyer_id, account_id } = req.query;
    
    if (!buyer_id || !account_id) {
      return res.status(400).json({ error: "Missing buyer_id or account_id" });
    }
    
    // Check for existing active orders
    const existingOrder = await db.select()
      .from(orders)
      .where(
        and(
          eq(orders.buyer_id, buyer_id),
          eq(orders.account_id, account_id),
          or(
            eq(orders.status, 'pending'),
            eq(orders.status, 'in_progress')
          )
        )
      )
      .limit(1);

    if (existingOrder.length > 0) {
      return res.status(400).json({ 
        error: "You already have an active order for this account" 
      });
    }
    
    res.json({ exists: false });
  } catch (error) {
    console.error("Error checking order:", error);
    res.status(500).json({ 
      error: "Failed to check order status",
      details: error.message 
    });
  }
});

app.post("/orders", async (req, res) => {
  try {
    const { buyer_id, account_id, amount } = req.body;
    
    // Check if user already has an active order for this account
    const existingOrder = await db.select()
      .from(orders)
      .where(
        and(
          eq(orders.buyer_id, buyer_id),
          eq(orders.account_id, account_id),
          or(
            eq(orders.status, 'pending'),
            eq(orders.status, 'in_progress')
          )
        )
      )
      .limit(1);

    if (existingOrder.length > 0) {
      return res.status(400).json({ 
        error: "You already have an active order for this account" 
      });
    }

    const result = await db.insert(orders).values({
      buyer_id,
      account_id,
      amount,
      status: 'pending',
      created_at: new Date(),
      updated_at: new Date()
    }).returning();
    
    res.status(201).json(result[0]);
  } catch (error) {
    console.error("Error creating order:", error);
    res.status(500).json({ 
      error: "Failed to create order",
      details: error.message 
    });
  }
});


// app.get("/orders", async (req, res) => {
//   try {
//     const result = await db.select().from(orders);
//     res.json(result);
//   } catch (error) {
//     console.error("Error fetching orders:", error);
//     res.status(500).json({ error: "Failed to fetch orders" });
//   }
// });


app.get("/orders/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.select().from(orders)
      .where(eq(orders.id, id))
      .innerJoin(users, eq(orders.buyer_id, users.id))
      .innerJoin(accounts, eq(orders.account_id, accounts.id));

    if (result.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    const orderResult = result[0];
    const sellerRes = await db.select().from(users).where(eq(users.id, orderResult.accounts.owner_id));
    
    if (sellerRes.length === 0) {
      return res.status(404).json({ error: "Seller not found for this order" });
    }

    const finalResult = {
      order: orderResult.orders,
      account: orderResult.accounts,
      buyer: orderResult.users,
      seller: sellerRes[0]
    };

    res.json(finalResult);
  } catch (error) {
    console.error("Error fetching order:", error);
    res.status(500).json({ error: "Failed to fetch order" });
  }
});

app.put("/orders/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ error: "Status is required" });
    }

    // First get the order details before updating
    const orderDetails = await db.select()
      .from(orders)
      .where(eq(orders.id, id))
      .leftJoin(accounts, eq(orders.account_id, accounts.id));

    if (orderDetails.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Update the order status
    const result = await db.update(orders)
      .set({ status, updated_at: new Date() })
      .where(eq(orders.id, id))
      .returning();

    // If status is completed, clean up after a short delay to allow notifications to be sent
    if (status === 'completed') {
      const order = result[0];
      // Set a small delay to ensure notifications are sent before deletion
      setTimeout(async () => {
        try {
          // First delete all orders associated with this account
          await db.delete(orders).where(eq(orders.account_id, order.account_id));
          // Then delete the account
          await db.delete(accounts).where(eq(accounts.id, order.account_id));
        } catch (error) {
          console.error('Error during cleanup after order completion:', error);
        }
      }, 5000); // 5 second delay to ensure notifications are sent
    }

    res.json(result[0]);
  } catch (error) {
    console.error("Error updating order:", error);
    res.status(500).json({ error: "Failed to update order" });
  }
});

app.delete("/orders/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.delete(orders).where(eq(orders.id, id)).returning();
    if (result.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }
    res.json({ success: true, deleted: result[0] });
  } catch (error) {
    console.error("Error deleting order:", error);
    res.status(500).json({ error: "Failed to delete order" });
  }
});

app.post("/transfers", async (req, res) => {
  try {
    const { order_id, seller_id, buyer_id } = req.body;
    const result = await db.insert(transfers).values({
      order_id,
      seller_id,
      buyer_id,
    }).returning();
    res.json(result[0]);
  } catch (error) {
    console.error("Error creating transfer:", error);
    res.status(500).json({ error: "Failed to create transfer" });
  }
});

app.put("/transfers/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const result = await db.update(transfers).set({ status }).where(eq(transfers.id, id)).returning();
    res.json(result[0]);
  } catch (error) {
    console.error("Error updating transfer:", error);
    res.status(500).json({ error: "Failed to update transfer" });
  }
});

// If you want to fetch by telegram_user_id
app.get('/users/by-telegram/:telegram_user_id', async (req, res) => {
  console.log('fetching user by telegram_user_id')
  try {
    const { telegram_user_id } = req.params;
    console.log('telegram_user_id', telegram_user_id)
    const result = await db.select().from(users).where(eq(users.telegram_user_id, telegram_user_id));
    console.log('result', result)
    if (result.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json(result[0]);
  } catch (error) {
    console.error("Error fetching user by telegram_user_id:", error);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// Add this new endpoint to delete an account
app.delete('/accounts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // First check if the account exists
    const existingAccount = await db.select().from(accounts).where(eq(accounts.id, id));
    if (existingAccount.length === 0) {
      return res.status(404).json({ error: "Account not found" });
    }

    // Check if there are any pending orders for this account
    const pendingOrders = await db.select()
      .from(orders)
      .where(
        and(
          eq(orders.account_id, id),
          or(
            eq(orders.status, 'pending'),
            eq(orders.status, 'in_progress')
          )
        )
      );

    if (pendingOrders.length > 0) {
      return res.status(400).json({ 
        error: "Cannot delete account with pending orders. Please complete or cancel all orders first." 
      });
    }

    // Delete all completed orders for this account first (to maintain referential integrity)
    await db.delete(orders).where(eq(orders.account_id, id));
    
    // Then delete the account
    const result = await db.delete(accounts).where(eq(accounts.id, id)).returning();
    
    if (result.length === 0) {
      return res.status(404).json({ error: "Account not found" });
    }

    res.json({ 
      success: true, 
      message: "Account deleted successfully",
      deleted: result[0] 
    });
  } catch (error) {
    console.error("Error deleting account:", error);
    res.status(500).json({ error: "Failed to delete account" });
  }
});

// Add this endpoint to get orders for a specific account (used for validation)
app.get('/accounts/:id/orders', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await db.select()
      .from(orders)
      .where(eq(orders.account_id, id));
    
    res.json(result);
  } catch (error) {
    console.error("Error fetching account orders:", error);
    res.status(500).json({ error: "Failed to fetch account orders" });
  }
});

// Start the server


app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});