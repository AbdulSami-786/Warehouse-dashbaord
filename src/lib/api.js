// One function per action. CONFIG.backend decides where they run: the Google
// Sheet through sheetsAdapter.js, or this browser through localAdapter.js.

import { CONFIG } from './config.js';
import { localCall } from './localAdapter.js';
import { sheetsCall } from './sheetsAdapter.js';
import { hybridCall, isDesktop } from './hybridAdapter.js';

// The desktop app keeps working without internet (hybridAdapter.js); the web
// dashboard always talks to the Sheet directly.
const call = CONFIG.backend === 'sheets' ? (isDesktop ? hybridCall : sheetsCall) : localCall;

export const api = {
  login: (username, password) => call('login', { username, password }),
  logout: () => call('logout'),
  changePassword: (oldPassword, newPassword) => call('changePassword', { oldPassword, newPassword }),
  bootstrap: () => call('bootstrap'),

  saveParty: (p) => call('saveParty', p),
  archiveParty: (id) => call('archiveParty', { id }),
  setPartyLock: (partyId, password, currentPassword) => call('setPartyLock', { partyId, password, currentPassword }),

  saveItem: (p) => call('saveItem', p),
  archiveItem: (id) => call('archiveItem', { id }),

  saveBill: (p) => call('saveBill', p),
  voidBill: (id, reason) => call('voidBill', { id, reason }),
  deleteBill: (id, reason) => call('deleteBill', { id, reason }),
  setDelivery: (id, delivery) => call('setDelivery', { id, delivery }),
  setLineDelivery: (billId, lines) => call('setLineDelivery', { billId, lines }),
  deliverFromWarehouse: (billId, warehouseId, lines) => call('deliverFromWarehouse', { billId, warehouseId, lines }),

  addPayment: (p) => call('addPayment', p),
  reversePayment: (id, reason) => call('reversePayment', { id, reason }),
  deletePayment: (id, reason, orphan = false) => call('deletePayment', { id, reason, orphan }),
  updatePayment: (p) => call('updatePayment', p),
  settleParty: (p) => call('settleParty', p),

  addReturn: (p) => call('addReturn', p),

  saveCheque: (p) => call('saveCheque', p),
  setChequeStatus: (id, status) => call('setChequeStatus', { id, status }),
  deleteCheque: (id, reason) => call('deleteCheque', { id, reason }),

  addAdvance: (p) => call('addAdvance', p),
  deleteAdvance: (id, reason) => call('deleteAdvance', { id, reason }),

  savePurchase: (p) => call('savePurchase', p),
  updatePurchase: (p) => call('updatePurchase', p),
  deletePurchase: (id, reason) => call('deletePurchase', { id, reason }),

  saveSupplier: (p) => call('saveSupplier', p),
  archiveSupplier: (id) => call('archiveSupplier', { id }),
  savePurchaseBill: (p) => call('savePurchaseBill', p),
  voidPurchaseBill: (id, reason) => call('voidPurchaseBill', { id, reason }),
  setPurchaseReceipt: (purchaseBillId, lines) => call('setPurchaseReceipt', { purchaseBillId, lines }),
  addSupplierPayment: (p) => call('addSupplierPayment', p),
  deleteSupplierPayment: (id, reason) => call('deleteSupplierPayment', { id, reason }),
  addSupplierReturn: (p) => call('addSupplierReturn', p),
  deleteSupplierReturn: (id) => call('deleteSupplierReturn', { id }),
  linkPartySupplier: (partyId, supplierId) => call('linkPartySupplier', { partyId, supplierId }),
  setOffParty: (p) => call('setOffParty', p),

  saveEmployee: (p) => call('saveEmployee', p),
  addEmployeeTx: (p) => call('addEmployeeTx', p),

  saveExpense: (p) => call('saveExpense', p),
  saveStockLoss: (p) => call('saveStockLoss', p),
  saveAsset: (p) => call('saveAsset', p),

  saveJournal: (p) => call('saveJournal', p),
  deleteJournal: (id) => call('deleteJournal', { id }),
  addJournalPayment: (p) => call('addJournalPayment', p),
  deleteJournalPayment: (id, reason) => call('deleteJournalPayment', { id, reason }),

  saveSettings: (p) => call('saveSettings', p),

  createShareLink: (partyId, password) => call('createShareLink', { partyId, password }),
  revokeShareLink: (partyId) => call('revokeShareLink', { partyId }),
  openSharedLedger: (token, password) => call('openSharedLedger', { token, password }),

  fullBackup: () => call('fullBackup'),

  // Warehouse system
  saveWarehouse: (p) => call('saveWarehouse', p),
  archiveWarehouse: (id) => call('archiveWarehouse', { id }),
  saveWhMove: (p) => call('saveWhMove', p),
  voidWhMove: (id, reason) => call('voidWhMove', { id, reason }),
  saveWhExpense: (p) => call('saveWhExpense', p),
  deleteWhExpense: (id, reason) => call('deleteWhExpense', { id, reason }),
  saveStockCount: (p) => call('saveStockCount', p),
  setWhMoveRates: (id, rates) => call('setWhMoveRates', { id, rates }),

  // Warehouse parties: who goods come from and go to, each with a khata
  saveWhParty: (p) => call('saveWhParty', p),
  archiveWhParty: (id) => call('archiveWhParty', { id }),
  setWhPartyLock: (partyId, password, currentPassword) => call('setWhPartyLock', { partyId, password, currentPassword }),
  addWhPartyPayment: (p) => call('addWhPartyPayment', p),
  deleteWhPartyPayment: (id, reason) => call('deleteWhPartyPayment', { id, reason }),
  createWhShareLink: (partyId, password) => call('createWhShareLink', { partyId, password }),
  revokeWhShareLink: (partyId) => call('revokeWhShareLink', { partyId }),

  // Users and import — super admin only
  listUsers: () => call('listUsers'),
  saveUser: (p) => call('saveUser', p),
  deleteUser: (id) => call('deleteUser', { id }),
  importBatch: (ops, label) => call('importBatch', { ops, label }),
};
