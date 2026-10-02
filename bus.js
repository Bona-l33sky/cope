// A tiny message bus so the live feed can push updates to open browsers instantly.
const EventEmitter = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(0);
module.exports = bus;
