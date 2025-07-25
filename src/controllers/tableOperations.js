// Table operations controller - extracted from backend
const { pool } = require('../config/db');
const { createOrUpdateOrder } = require('@butler/order-engine/src/controllers/orderController');

// Utility functions - simplified for local usage
const insertNotification = async (notificationData) => {
  try {
    // Simple notification insertion
    const query = `
      INSERT INTO notifications (
        restaurant_id, table_number, order_id, action_type, 
        notification_data, order_type, captain_id, active, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      RETURNING notification_id
    `;
    
    const values = [
      notificationData.restaurantId,
      notificationData.tableNumber,
      notificationData.orderId,
      notificationData.actionType,
      JSON.stringify(notificationData.notificationData),
      notificationData.orderType || 'captain',
      notificationData.captainId || null,
      true
    ];
    
    const result = await pool.query(query, values);
    return result.rows[0];
  } catch (error) {
    console.error('Error inserting notification:', error);
    return null;
  }
};

const sendNotificationToRestaurant = async (title, message, data, restaurantId, type, active = false) => {
  // Simplified notification sending - just log for now
  console.log('Sending notification to restaurant:', { title, message, data, restaurantId, type, active });
  return { success: true };
};

// For Redis session management, use placeholder for now since Redis is disabled in local context
const migrateTableSessions = async (restaurantId, oldTableId, newTableId) => {
  // Placeholder - Redis session management disabled in local context
  console.log('Migrating table sessions:', { restaurantId, oldTableId, newTableId });
  return { success: true };
};

/**
 * Move specific items from one table to another
 * @param {Object} data - Move items data
 * @param {string} data.restaurantId - Restaurant ID
 * @param {string} data.oldTableId - Source table ID
 * @param {string} data.newTableId - Destination table ID
 * @param {string} data.orderId - Order ID on old table
 * @param {Array<Object>} data.items - Items to move
 * @param {string} data.items[].itemId - Item ID
 * @param {number} data.items[].quantity - Quantity to move
 */
const moveItems = async (data) => {
  try {
    const { restaurantId, oldTableId, newTableId, orderId, items } = data;

    // 1. Validate inputs and fetch current state
    const [oldOrders, notifications, deliveries] = await Promise.all([
      pool.query(
        `SELECT * FROM orders WHERE restaurant_id = $1 AND id = $2 AND table_id = $3`,
        [restaurantId, orderId, oldTableId]
      ),
      pool.query(
        `SELECT * FROM notifications 
         WHERE restaurant_id = $1 
         AND order_id = $2 
         AND action_type IN ('order_created', 'order-updated')
         AND active = true`,
        [restaurantId, orderId]
      ),
      pool.query(
        `SELECT id, notification_id, item_id, customization_details 
         FROM order_customization_deliveries 
         WHERE order_id = $1 
         AND delivered = false 
         AND cancelled = false`,
        [orderId]
      )
    ]);

    // If order not found, return error
    if (!oldOrders.rows.length) {
      console.log("Order not found on source table");
      throw new Error('Order not found on source table');
    }

    const oldOrder = oldOrders.rows[0];
    const oldItems = oldOrder.json_data.items;

    // 2. Verify requested moves
    for (const { itemId, quantity } of items) {
      if (!oldItems[itemId]) {
        throw new Error(`Item ${itemId} not found in the order`);
      }
      if (quantity < 1) {
        throw new Error('Quantity must be at least 1');
      }
    }

    // 3. Check if this is a full table move
    let isFullTableMove = true;
    const requestedItems = new Set(items.map(i => i.itemId));
    
    for (const itemId of Object.keys(oldItems)) {
      if (!requestedItems.has(itemId)) {
        isFullTableMove = false;
        break;
      }
    }

    if (isFullTableMove) {
      for (const { itemId, quantity } of items) {
        const item = oldItems[itemId];
        const totalQty = item.customizations.reduce((sum, c) => sum + c.qty, 0);
        if (quantity !== totalQty) {
          isFullTableMove = false;
          break;
        }
      }
    }

    if (isFullTableMove) {
      console.log("Moving table since all items are being moved with exact quantities");
      return await moveTable(data);
    }

    // 4. Prepare items for both tables
    const itemsForNewTable = {};
    const remainingItems = { ...oldItems };
    
    // Track which notifications and deliveries need updating
    const notificationUpdates = [];
    const deliveryUpdates = [];

    for (const { itemId, quantity: requestedQty } of items) {
      const item = oldItems[itemId];
      const totalQty = item.customizations.reduce((sum, c) => sum + c.qty, 0);
      let remainingQtyToMove = requestedQty;

      // For the new table - use requested quantity
      itemsForNewTable[itemId] = {
        ...item,
        customizations: item.customizations.map(c => ({ 
          ...c, 
          qty: requestedQty
        }))
      };

      // For the old table - remove only what exists
      if (requestedQty >= totalQty) {
        delete remainingItems[itemId];
      } else {
        remainingItems[itemId] = {
          ...item,
          customizations: item.customizations.map(c => ({
            ...c,
            qty: Math.max(0, c.qty - requestedQty)
          })).filter(c => c.qty > 0)
        };
      }

      // Group deliveries by notification_id for this item
      const itemDeliveries = deliveries.rows
        .filter(d => d.item_id === itemId)
        .reduce((acc, d) => {
          if (!acc[d.notification_id]) {
            acc[d.notification_id] = [];
          }
          acc[d.notification_id].push(d);
          return acc;
        }, {});

      // For each notification of this item
      for (const notification of notifications.rows) {
        const notifDeliveries = itemDeliveries[notification.notification_id] || [];
        if (notifDeliveries.length === 0) continue;

        let qtyToReduceFromThisNotif = Math.min(
          remainingQtyToMove,
          notifDeliveries.reduce((sum, d) => sum + (d.customization_details.qty || 0), 0)
        );

        if (qtyToReduceFromThisNotif <= 0) continue;

        // Update each delivery under this notification
        for (const delivery of notifDeliveries) {
          if (qtyToReduceFromThisNotif <= 0) break;

          const currentQty = delivery.customization_details.qty || 0;
          const qtyToReduceFromThisDelivery = Math.min(
            qtyToReduceFromThisNotif,
            currentQty
          );

          if (qtyToReduceFromThisDelivery > 0) {
            const newCustomizationDetails = {
              ...delivery.customization_details,
              qty: currentQty - qtyToReduceFromThisDelivery
            };

            deliveryUpdates.push({
              id: delivery.id,
              customization_details: newCustomizationDetails
            });

            qtyToReduceFromThisNotif -= qtyToReduceFromThisDelivery;
            remainingQtyToMove -= qtyToReduceFromThisDelivery;
          }
        }

        // If we modified any deliveries for this notification
        if (qtyToReduceFromThisNotif < remainingQtyToMove) {
          notificationUpdates.push(notification.notification_id);
        }
      }
    }

    // 5. Update notifications and deliveries
    if (deliveryUpdates.length > 0) {
      await Promise.all(deliveryUpdates.map(update => 
        pool.query(
          `UPDATE order_customization_deliveries 
           SET customization_details = $1 
           WHERE id = $2`,
          [update.customization_details, update.id]
        )
      ));
    }

    // Get all active notifications for this order
    const activeNotifications = notifications.rows
      .filter(n => n.action_type === 'order_created' || n.action_type === 'order-updated')
      .filter(n => n.active)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));  // Process oldest first

    // Process each moved item
    for (const { itemId, quantity: qtyToMove } of items) {
      let remainingQtyToMove = qtyToMove;

      // Process each notification until we've moved all quantity
      for (const notification of activeNotifications) {
        if (remainingQtyToMove <= 0) break;

        const notifData = notification.notification_data;
        if (!notifData || !notifData[itemId]) continue;

        const targetItem = notifData[itemId];
        if (!targetItem || !targetItem.customizations) continue;

        // Calculate how much we can take from this notification
        const basicCustomization = targetItem.customizations.find(c => c.isBasic === true);
        if (!basicCustomization) continue;

        const currentQty = basicCustomization.qty || 0;
        const currentQtyChange = basicCustomization.qtyChange || currentQty;

        if (currentQty <= 0) continue;

        const qtyToReduceHere = Math.min(remainingQtyToMove, currentQty);
        remainingQtyToMove -= qtyToReduceHere;

        // Update this notification
        await pool.query(
          `UPDATE notifications 
           SET notification_data = jsonb_set(
             notification_data,
             array[$1::text],
             jsonb_build_object(
               'name', notification_data->$1->>'name',
               'added', notification_data->$1->>'added',
               'customizations', (
                 SELECT jsonb_agg(
                   CASE 
                     WHEN c->>'isBasic' = 'true' THEN
                       jsonb_build_object(
                         'qty', ((c->>'qty')::int - $2),
                         'price', c->>'price',
                         'addons', c->'addons',
                         'isBasic', true,
                         'qtyChange', ((c->>'qtyChange')::int - $2),
                         'variation', c->'variation',
                         'instructions', c->>'instructions'
                       )
                     ELSE c
                   END
                 )
                 FROM jsonb_array_elements(notification_data->$1->'customizations') c
               )
             )
           ),
           updated_at = CURRENT_TIMESTAMP
           WHERE notification_id = $3
           AND active = true`,
          [itemId, qtyToReduceHere, notification.notification_id]
        );
      }
    }

    // Clean up notifications: delete NULL ones and deactivate empty ones
    await Promise.all([
      // Delete notifications with NULL data
      pool.query(
        `DELETE FROM notifications 
         WHERE notification_id = ANY($1)
         AND notification_data IS NULL`,
        [activeNotifications.map(n => n.notification_id)]
      ),
      
      // Delete notifications with zero quantities instead of just deactivating
      pool.query(
        `DELETE FROM notifications 
         WHERE notification_id = ANY($1)
         AND notification_data IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM jsonb_each(notification_data) items,
           jsonb_array_elements(items.value->'customizations') c
           WHERE (c->>'qty')::int > 0
         )`,
        [activeNotifications.map(n => n.notification_id)]
      )
    ]);

    // 6. Handle both tables
    if (Object.keys(remainingItems).length === 0) {
      // If no items left, delete the order
      await pool.query(
        `DELETE FROM orders WHERE restaurant_id = $1 AND id = $2`,
        [restaurantId, orderId]
      );
    } else {
      // Update old table's order directly
      await pool.query(
        `UPDATE orders 
         SET json_data = jsonb_set(json_data, '{items}', $1::jsonb),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND restaurant_id = $3`,
        [JSON.stringify(remainingItems), orderId, restaurantId]
      );
    }

    // Create/update order on new table
    // Check if destination table has any non-printed orders to merge with
    const destOrderResult = await pool.query(
      `SELECT id, print_status FROM orders 
       WHERE restaurant_id = $1 AND table_id = $2
       ORDER BY print_status ASC, created_at ASC`,
      [restaurantId, newTableId]
    );

    let mockReq;
    // Check if there's a non-printed order to merge with
    const nonPrintedOrder = destOrderResult.rows.find(order => order.print_status !== true);
    
    if (destOrderResult.rows.length > 0 && !nonPrintedOrder) {
      // All orders on destination table are printed - create a new order
      console.log("All orders on destination table are printed, creating new order");
      mockReq = {
        body: {
          restaurantId,
          tableId: newTableId,
          items: itemsForNewTable,
          orderType: 'captain',
          forceNewOrder: true // Flag to indicate we want a new order
        }
      };
    } else {
      // Normal case - merge with existing non-printed order or create new one
      mockReq = {
      body: {
        restaurantId,
        tableId: newTableId,
        items: itemsForNewTable,
        orderType: 'captain'
      }
    };
    }

    const mockRes = {
      status: (code) => ({
        json: (data) => {
          console.log('Order update response:', { code, data });
          return data;
        }
      })
    };

    await createOrUpdateOrder(mockReq, mockRes);

    return {
      success: true,
      message: 'Items moved successfully'
    };

  } catch (error) {
    console.error('Error moving items:', error);
    throw error;
  }
};

const moveTable = async (data) => {
  try {
    const { oldTableId, newTableId, restaurantId, orderId } = data;
    if (!oldTableId || !newTableId || !restaurantId) {
      throw new Error('Missing required fields');
    }

    // 1. Fetch destination + source orders, now including print_status
    const destRes = await pool.query(
      `SELECT id, json_data, instructions, print_status
         FROM orders
        WHERE restaurant_id = $1
          AND table_id      = $2
         ORDER BY print_status ASC, created_at ASC`,
      [restaurantId, newTableId]
    );
    const srcRes = await pool.query(
      `SELECT id, json_data, instructions
         FROM orders
        WHERE restaurant_id = $1
          AND table_id      = $2`,
      [restaurantId, oldTableId]
    );

    // 2. Both tables have orders?
    if (destRes.rows.length > 0 && srcRes.rows.length > 0) {
      // Find the first non-printed order on destination table, or use the first order if all are printed
      const destOrder = destRes.rows.find(order => order.print_status !== true) || destRes.rows[0];
      const srcOrder  = srcRes.rows[0];
      
      // 2a. Destination NOT printed → MERGE (your existing logic)
      if (!destOrder.print_status) {
        const existingItems = destOrder.json_data.items || {};
        const sourceItems   = srcOrder.json_data.items   || {};
        const mergedItems   = { ...existingItems };

      for (const [itemId, itemData] of Object.entries(sourceItems)) {
        if (mergedItems[itemId]) {
          mergedItems[itemId].customizations = [
            ...mergedItems[itemId].customizations,
            ...itemData.customizations
          ];
        } else {
          mergedItems[itemId] = itemData;
        }
      }
      const mergedInstructions = [
          destOrder.instructions,
          srcOrder.instructions
      ].filter(Boolean).join('\n');

      await pool.query(
          `UPDATE orders
              SET json_data   = $1,
                  instructions = $2,
                  updated_at    = CURRENT_TIMESTAMP
            WHERE id = $3`,
          [{ items: mergedItems }, mergedInstructions, destOrder.id]
      );

        await pool.query(
        `UPDATE notifications 
              SET order_id     = $1,
             table_number = $2,
                  updated_at   = CURRENT_TIMESTAMP
         WHERE restaurant_id = $3 
              AND order_id       = $4
              AND active         = true`,
          [destOrder.id, newTableId, restaurantId, srcOrder.id]
      );

        await pool.query(
        `UPDATE order_customization_deliveries 
         SET order_id = $1
            WHERE order_id = $2`,
          [destOrder.id, srcOrder.id]
      );

        // delete the old source order
        await pool.query(`DELETE FROM orders WHERE id = $1`, [srcOrder.id]);
      }
      // 2b. Destination **printed** → REUSE source.id (Option A)
      else {
        // simply move the row
      await pool.query(
          `UPDATE orders
              SET table_id   = $1,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id         = $2`,
          [newTableId, srcRes.rows[0].id]
      );
        // (no need to touch notifications here — step 4 handles them)
      }
    }
    // 3. Only source has an order → simple move
    else if (srcRes.rows.length > 0) {
      await pool.query(
        `UPDATE orders
            SET table_id   = $1,
                updated_at = CURRENT_TIMESTAMP
          WHERE id         = $2`,
        [newTableId, srcRes.rows[0].id]
      );
    }

    // 4. Update ALL related tables exactly as before
    const [
      notificationsUpdate,
      otpUpdate,
      discountUpdate,
      dynamicOffersUpdate,
      captainsUpdate
    ] = await Promise.all([
      pool.query(
        `UPDATE notifications
            SET table_number = $1
          WHERE restaurant_id = $2
            AND table_number  = $3
            AND active        = true`,
        [newTableId, restaurantId, oldTableId]
      ),
      pool.query(
        `UPDATE table_otps
            SET table_id = $1
          WHERE restaurant_id = $2
            AND table_id      = $3`,
        [newTableId, restaurantId, oldTableId]
      ),
      pool.query(
        `UPDATE discounts
            SET table_number = $1,
                updated_at   = CURRENT_TIMESTAMP
          WHERE restaurant_id = $2
            AND table_number  = $3
            AND is_active     = true`,
        [newTableId, restaurantId, oldTableId]
      ),
      pool.query(
        `UPDATE dynamic_offers
            SET table_id = $1
          WHERE restaurant_id = $2
            AND order_id      = $3
            AND table_id      = $4
            AND active        = true`,
        [newTableId, restaurantId, orderId, oldTableId]
      ),
      pool.query(
        `UPDATE captains
         SET assigned_tables = (
           SELECT jsonb_agg(DISTINCT CASE
             WHEN value = to_jsonb($1::text) THEN to_jsonb($2::text)
             ELSE value END
           )
           FROM jsonb_array_elements(assigned_tables) AS arr(value)
         )
          WHERE restaurant_id   = $3
           AND assigned_tables @> to_jsonb($1::text)`,
        [oldTableId, newTableId, restaurantId]
      )
    ]);

    // 5. Migrate sessions
    await migrateTableSessions(restaurantId, oldTableId, newTableId);

    // 6. Send notifications
    await sendNotificationToRestaurant('', '', { tableId: oldTableId }, restaurantId, 'captain', true);
    await sendNotificationToRestaurant(
      'Table Move Completed',
      `Table move from ${oldTableId} to ${newTableId} completed.`,
      { oldTable: oldTableId, newTable: newTableId, tableId: newTableId },
      restaurantId,
      'biller'
    );

    // 7. Return summary
    return {
      success: true,
      message: 'Table moved successfully',
      ordersUpdated: notificationsUpdate.rowCount + otpUpdate.rowCount + discountUpdate.rowCount + dynamicOffersUpdate.rowCount + captainsUpdate.rowCount,
      notificationsUpdated: notificationsUpdate.rowCount,
      otpUpdated: otpUpdate.rowCount,
      discountUpdated: discountUpdate.rowCount,
      dynamicOffersUpdated: dynamicOffersUpdate.rowCount,
      captainsUpdated: captainsUpdate.rowCount,
    };
  } catch (error) {
    console.error('Error moving table:', error);
    throw error;
  }
};



const moveKOT = async (reqOrData, res) => {
  try {
    // Support both (req, res) and (data) signatures
    let oldTableId, newTableId, restaurantId, orderId, notificationIds;
    let isExpress = false;
    if (reqOrData && reqOrData.body) {
      // Express handler style
      isExpress = true;
      ({ oldTableId, newTableId, restaurantId, orderId, notificationIds } = reqOrData.body);
    } else {
      // Utility style
      ({ oldTableId, newTableId, restaurantId, orderId, notificationIds } = reqOrData);
    }

    // 0. Validate inputs
    if (!oldTableId || !newTableId || !restaurantId || !orderId || !Array.isArray(notificationIds)) {
      if (isExpress && res) {
        return res.status(400).json({ error: 'Missing required fields' });
      } else {
        return { success: false, error: 'Missing required fields' };
      }
    }

    // 1. Count total KOT notifications on this order
    const { rows: [{ total }] } = await pool.query(
      `SELECT COUNT(*)::int AS total
         FROM notifications
        WHERE restaurant_id = $1
          AND order_id       = $2
          AND action_type IN ('order_created','order-updated')
          AND active = true`,
      [restaurantId, orderId]
    );
    console.log("Total notifications on this order:", total);
    // 2. If all notifications are being moved, delegate to moveTable
    if (notificationIds.length === total) {
      console.log("Moving table Since all KOTs are being moved");
      if (isExpress && res) {
        return moveTable({ oldTableId, newTableId, restaurantId, orderId });
      } else {
        return moveTable({ oldTableId, newTableId, restaurantId, orderId });
      }
    }

    // 3. Otherwise, update only the selected notifications
    await pool.query(
      `DELETE FROM notifications
        WHERE restaurant_id = $1
          AND order_id = $2
          AND notification_id = ANY($3::int[])`,
      [restaurantId, orderId, notificationIds]
    );

    // 4. Re-print just this one order on the new table
    //    fetch all items/customizations for the order
    const { rows: deliveries } = await pool.query(
      `SELECT item_id, customization_details
         FROM order_customization_deliveries
        WHERE notification_id = ANY($1::text[])`,
      [ notificationIds.map(String) ]
    );

    // 5. Build items object and call createOrUpdateOrder
    const itemsToPrint = {};
    for (const d of deliveries) {
      if (!itemsToPrint[d.item_id]) {
        itemsToPrint[d.item_id] = { customizations: [] };
      }
      itemsToPrint[d.item_id].customizations.push(d.customization_details);
    }
    

    // Check if destination table has any non-printed orders to merge with
    const destOrderResult = await pool.query(
      `SELECT id, print_status FROM orders 
       WHERE restaurant_id = $1 AND table_id = $2
       ORDER BY print_status ASC, created_at ASC`,
      [restaurantId, newTableId]
    );

    let mockReq;
    const nonPrintedOrder = destOrderResult.rows.find(order => order.print_status !== true);

    if (destOrderResult.rows.length > 0 && !nonPrintedOrder) {
      // All orders on destination table are printed - create a new order
      mockReq = {
        body: {
          restaurantId,
          tableId: newTableId,
          items: itemsToPrint,
          orderType: 'captain',
          forceNewOrder: true
        },
        app: { get: () => undefined }
      };
    } else if (nonPrintedOrder) {
      // Merge with existing non-printed order
      mockReq = {
        body: {
          restaurantId,
          tableId: newTableId,
          items: itemsToPrint,
          orderType: 'captain',
          orderId: nonPrintedOrder.id
        },
        app: { get: () => undefined }
      };
    } else {
      // No orders on destination table - create new order
      mockReq = {
        body: {
          restaurantId,
          tableId: newTableId,
          items: itemsToPrint,
          orderType: 'captain'
        },
        app: { get: () => undefined }
      };
    }

    await createOrUpdateOrder(
      mockReq,
      { status: () => ({ json: () => {} }) }
    );

    await pool.query(
      `DELETE FROM order_customization_deliveries
        WHERE notification_id = ANY($1::text[])`,
      [notificationIds.map(String)]
    );

    // 6. Remove the same items from the old table's order
    const { rows: oldOrders } = await pool.query(
      `SELECT * FROM orders WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, orderId]
    );
    if (oldOrders.length) {
      const oldOrder = oldOrders[0];
      const oldItems = oldOrder.json_data.items;

      // Build a map of items and customizations to remove (from deliveries)
      for (const d of deliveries) {
        const itemId = d.item_id;
        const moveCustom = d.customization_details;
        if (oldItems[itemId]) {
          const oldCustoms = oldItems[itemId].customizations;
          // Helper to compare customizations (variation + addons)
          const isSameCustomization = (a, b) => {
            return JSON.stringify(a.variation) === JSON.stringify(b.variation)
              && JSON.stringify(a.addons) === JSON.stringify(b.addons);
          };
          for (let i = 0; i < oldCustoms.length; i++) {
            if (isSameCustomization(moveCustom, oldCustoms[i])) {
              // Use qtyChange if present, else qty
              const qtyToRemove = moveCustom.qtyChange !== undefined ? moveCustom.qtyChange : moveCustom.qty;
              oldCustoms[i].qty -= qtyToRemove;
              if (oldCustoms[i].qty <= 0) {
                oldCustoms.splice(i, 1);
                i--; // adjust index after removal
              }
              break;
            }
          }
          // If no customizations left, remove the item
          if (oldCustoms.length === 0) {
            delete oldItems[itemId];
          } else {
            oldItems[itemId].customizations = oldCustoms;
            oldItems[itemId].totalQty = oldCustoms.reduce((sum, c) => sum + c.qty, 0);
          }
        }
      }
      // Save the updated order
      await pool.query(
        `UPDATE orders SET json_data = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify({ items: oldItems }), oldOrder.id]
      );
    }

    if (isExpress && res) {
      return res.status(200).json({ message: 'KOT moved successfully' });
    } else {
      return { success: true, message: 'KOT moved successfully' };
    }

  } catch (err) {
    console.error('Error moving KOT:', err);
    if (isExpress && res) {
      return res.status(500).json({ error: 'Internal server error' });
    } else {
      return { success: false, error: err?.message || 'Internal server error' };
    }
  }
};

exports.moveTable = moveTable;
exports.moveKOT = moveKOT;
exports.moveItems = moveItems; 