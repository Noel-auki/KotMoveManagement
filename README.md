# Table Operations Package

This package provides table and KOT (Kitchen Order Ticket) management operations for Butler POS.

## Installation

The package is already installed as a local dependency in the main Butler POS application:

```json
{
  "dependencies": {
    "@butler/table-operations": "file:src/deps/butler/packages/table-operations"
  }
}
```

## Usage

### Import the functions

```typescript
import { moveTable, moveKOT } from '@butler/table-operations';
```

### Move Table

Move an entire table (all orders) from one table to another:

```typescript
const moveData = {
  oldTableId: 'T1',
  newTableId: 'T2', 
  restaurantId: 'restaurant-123',
  orderId: 'order-456'
};

try {
  const response = await moveTable(moveData);
  console.log('Table moved successfully:', response);
} catch (error) {
  console.error('Error moving table:', error);
}
```

### Move KOT

Move specific KOTs or items from one table to another:

```typescript
const moveKOTData = {
  oldTableId: 'T1',
  newTableId: 'T2',
  restaurantId: 'restaurant-123', 
  orderId: 'order-456',
  notificationIds: [1, 2, 3] // Array of notification IDs to move
};

try {
  const response = await moveKOT(moveKOTData);
  console.log('KOT moved successfully:', response);
} catch (error) {
  console.error('Error moving KOT:', error);
}
```

## TypeScript Support

The package includes TypeScript declarations. The main types are:

- `MoveTableData`: Input data for moving tables
- `MoveTableResponse`: Response from table move operation
- `MoveKOTData`: Input data for moving KOTs
- `MoveKOTResponse`: Response from KOT move operation

## Features

- **Table Merging**: Automatically merges orders when moving to a table that already has orders
- **Database Updates**: Updates all related tables (notifications, OTPs, discounts, etc.)
- **Session Migration**: Handles Redis session migration
- **Notifications**: Sends appropriate notifications to restaurant staff
- **Error Handling**: Comprehensive error handling and logging

## Database Requirements

The package requires access to a PostgreSQL database with the following tables:
- orders
- notifications
- table_otps
- discounts
- dynamic_offers
- captains
- order_customization_deliveries

## Environment Variables

Make sure to set the following environment variables:
- `DB_HOST`: Database host
- `DB_PORT`: Database port
- `DB_NAME`: Database name
- `DB_USER`: Database username
- `DB_PASSWORD`: Database password 