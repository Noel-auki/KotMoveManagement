// Table operations package
const tableController = require('./controllers/tableOperations');

module.exports = {
    // Table operations
    moveTable: tableController.moveTable,
    moveKOT: tableController.moveKOT,
    moveItems: tableController.moveItems
}; 