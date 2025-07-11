declare module '@butler/table-operations' {
  interface MoveTableData {
    oldTableId: string;
    newTableId: string;
    restaurantId: string;
    orderId: string;
  }

  interface MoveTableResponse {
    success: boolean;
    message: string;
    ordersUpdated: number;
    notificationsUpdated: number;
    otpUpdated: number;
    discountUpdated: number;
    dynamicOffersUpdated: number;
    captainsUpdated: number;
  }

  interface MoveKOTData {
    oldTableId: string;
    newTableId: string;
    restaurantId: string;
    orderId: string;
    notificationIds: number[];
  }

  interface MoveKOTResponse {
    success: boolean;
    message: string;
  }

  interface MoveItemsData {
    oldTableId: string;
    newTableId: string;
    restaurantId: string;
    orderId: string;
    items: Array<{
      itemId: string;
      quantity: number;
    }>;
  }

  interface MoveItemsResponse {
    success: boolean;
    message: string;
  }

  export function moveTable(data: MoveTableData): Promise<MoveTableResponse>;
  export function moveKOT(data: MoveKOTData): Promise<MoveKOTResponse>;
  export function moveItems(data: MoveItemsData): Promise<MoveItemsResponse>;
} 