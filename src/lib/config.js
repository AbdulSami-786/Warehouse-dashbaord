// App-wide configuration.
//
// `backend` picks where every action runs:
//   'sheets' — the Google Apps Script Web App at `appsScriptUrl` (apps-script/Code.gs),
//              so every device sees the same Google Sheet. Needs internet.
//   'local'  — this browser's localStorage only; nothing leaves the device.

export const CONFIG = {
  defaultShopName: 'SGA Balloon Merchant',

  backend: 'sheets',
  appsScriptUrl: 'https://script.google.com/macros/s/AKfycbwnCAgvLHJaKJPQwVrL-PkaHia6Cs5QHD7_4sMG6C6tF8otMbEMjF74T-MAtSEWCuSL/exec',

  // Where shared party-ledger links point. Blank means this same page, which
  // is the only place the data exists while everything is stored locally.
  publicUrl: '',
};

export const PAYMENT_METHODS = ['Cash', 'JazzCash', 'EasyPaisa', 'HBL Bank', 'Cheque'];
export const UNITS = ['Piece', 'KG', 'Carton', 'Box', 'Dozen', 'Litre', 'Bag', 'Packet'];
export const EXPENSE_CATEGORIES = [
  'Rent', 'Utilities', 'Transport', 'Salaries', 'Stock Loss', 'Supplies',
  'Maintenance', 'Tea & Food', 'Miscellaneous',
];
export const LOSS_REASONS = ['Damaged', 'Expired', 'Lost', 'Other'];
export const CURRENCY = 'Rs';

// Warehouse side
export const WAREHOUSE_EXPENSE_CATEGORIES = [
  'Rent', 'Labour', 'Loading / Unloading', 'Transport', 'Electricity', 'Security',
  'Maintenance', 'Packing Material', 'Tea & Food', 'Miscellaneous',
];
export const ADJUST_REASONS = ['Damaged', 'Expired', 'Lost', 'Count correction', 'Found extra', 'Other'];
