const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store connected clients
const clients = new Set();

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('New client connected');
  clients.add(ws);

  // Handle incoming messages
  ws.on('message', (message) => {
    // Broadcast the message to all connected clients
    const messageString = message.toString();
    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageString);
      }
    });
  });

  // Handle client disconnection
  ws.on('close', () => {
    console.log('Client disconnected');
    clients.delete(ws);
  });

  // Handle errors
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

app.get('/', (req, res) => {
  res.json({ message: 'Welcome to the WebSocket backend API' });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Something went wrong!' });
});

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});