const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store rooms and their clients with usernames
const rooms = new Map();

// Helper function to get active users in a room
function getActiveUsers(room) {
  if (!rooms.has(room)) return [];
  return Array.from(rooms.get(room)).map(client => client.username);
}

// Broadcast message to all clients in a room
function broadcastToRoom(room, message) {
  if (rooms.has(room)) {
    rooms.get(room).forEach(({ws}) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    });
  }
}

wss.on('connection', (ws) => {
  console.log('New client connected');
  let clientRoom = null;
  let clientUsername = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'join') {
        clientRoom = data.room;
        clientUsername = data.username;

        // Create room if it doesn't exist
        if (!rooms.has(data.room)) {
          rooms.set(data.room, new Set());
        }

        // Add client to room with username
        rooms.get(data.room).add({ ws, username: data.username });

        // Send current active users list to the new user
        ws.send(JSON.stringify({
          type: 'userList',
          users: getActiveUsers(data.room)
        }));

        // Broadcast updated user list to all clients in the room
        broadcastToRoom(data.room, {
          type: 'userList',
          users: getActiveUsers(data.room)
        });

      } else if (data.type === 'message') {
        broadcastToRoom(data.room, {
          type: 'message',
          username: data.username,
          message: data.message
        });
      }
    } catch (error) {
      console.error('Message handling error:', error);
    }
  });

  ws.on('close', () => {
    if (clientRoom && rooms.has(clientRoom)) {
      const roomClients = rooms.get(clientRoom);
      
      // Remove the disconnected client
      for (const client of roomClients) {
        if (client.ws === ws) {
          roomClients.delete(client);
          break;
        }
      }

      // If room is empty, delete it
      if (roomClients.size === 0) {
        rooms.delete(clientRoom);
      } else {
        // Broadcast updated user list
        broadcastToRoom(clientRoom, {
          type: 'userList',
          users: getActiveUsers(clientRoom)
        });
      }
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Basic health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'WebSocket Chat Server',
    status: 'running',
    activeRooms: rooms.size
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Handle server shutdown gracefully
process.on('SIGTERM', () => {
  server.close(() => {
    console.log('Server shutdown complete');
    process.exit(0);
  });
});