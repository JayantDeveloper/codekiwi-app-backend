const WebSocket = require("ws");

/**
 * Send a message to all clients in the given session, optionally excluding one.
 * @param {WebSocket.Server} wss
 * @param {string} sessionCode
 * @param {object} payload
 * @param {WebSocket} [exclude]
 */
function broadcastToSession(wss, sessionCode, payload, exclude) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (
      client !== exclude &&
      client.readyState === WebSocket.OPEN &&
      client.sessionCode === sessionCode
    ) {
      client.send(msg);
    }
  });
}

/**
 * Send a message to every connected client regardless of session.
 * @param {WebSocket.Server} wss
 * @param {object} payload
 */
function broadcastAll(wss, payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

module.exports = { broadcastToSession, broadcastAll };
