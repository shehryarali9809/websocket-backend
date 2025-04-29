const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// MongoDB Connection
const MONGODB_URI = 'mongodb+srv://shehryarali8709:rv9aYKI8iZwxN4Wm@cluster0.wgaq9bv.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
mongoose.connect(MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Define MongoDB schemas and models
const messageSchema = new mongoose.Schema({
  room: { type: String, required: true, index: true },
  username: { type: String, required: true },
  message: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
});

const roomSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  createdBy: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  lastActivity: { type: Date, default: Date.now }
});

const Message = mongoose.model('Message', messageSchema);
const Room = mongoose.model('Room', roomSchema);

// Store rooms and their clients with usernames
const activeRooms = new Map();

// Helper function to get active users in a room
function getActiveUsers(room) {
  if (!activeRooms.has(room)) return [];
  return Array.from(activeRooms.get(room)).map(client => client.username);
}

// Broadcast message to all clients in a room
function broadcastToRoom(room, message) {
  if (activeRooms.has(room)) {
    activeRooms.get(room).forEach(({ws}) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    });
  }
}

// Get previous messages for a room
async function getPreviousMessages(room) {
  try {
    return await Message.find({ room })
      .sort({ timestamp: 1 })
      .limit(100) // Limit to last 100 messages
      .lean();
  } catch (error) {
    console.error('Error fetching previous messages:', error);
    return [];
  }
}

// Update last activity timestamp for a room
async function updateRoomActivity(roomName) {
  try {
    await Room.findOneAndUpdate(
      { name: roomName },
      { lastActivity: new Date() }
    );
  } catch (error) {
    console.error('Error updating room activity:', error);
  }
}

// API Endpoints for room management
app.get('/api/rooms', async (req, res) => {
  try {
    const rooms = await Room.find().sort({ lastActivity: -1 }).lean();
    res.json(rooms);
  } catch (error) {
    console.error('Error fetching rooms:', error);
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

app.post('/api/rooms', async (req, res) => {
  try {
    const { name, username } = req.body;
    
    if (!name || !username) {
      return res.status(400).json({ error: 'Room name and username are required' });
    }
    
    // Check if room already exists
    const existingRoom = await Room.findOne({ name });
    if (existingRoom) {
      return res.status(409).json({ error: 'Room with this name already exists' });
    }
    
    const newRoom = new Room({
      name,
      createdBy: username,
      lastActivity: new Date()
    });
    
    await newRoom.save();
    res.status(201).json(newRoom);
  } catch (error) {
    console.error('Error creating room:', error);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// Get messages for a specific room
app.get('/api/rooms/:roomName/messages', async (req, res) => {
  try {
    const { roomName } = req.params;
    
    // Check if room exists
    const roomExists = await Room.findOne({ name: roomName });
    if (!roomExists) {
      return res.status(404).json({ error: 'Room not found' });
    }
    
    const messages = await Message.find({ room: roomName })
      .sort({ timestamp: 1 })
      .limit(100)
      .lean();
      
    res.json(messages);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

wss.on('connection', (ws) => {
  console.log('New client connected');
  let clientRoom = null;
  let clientUsername = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'join') {
        clientRoom = data.room;
        clientUsername = data.username;

        // Check if room exists in database
        const roomExists = await Room.findOne({ name: data.room });
        if (!roomExists) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Room does not exist'
          }));
          return;
        }

        // Update room's last activity timestamp
        await updateRoomActivity(data.room);

        // Create active room if it doesn't exist in memory
        if (!activeRooms.has(data.room)) {
          activeRooms.set(data.room, new Set());
        }

        // Add client to room with username
        activeRooms.get(data.room).add({ ws, username: data.username });

        // Get previous messages from MongoDB
        const previousMessages = await getPreviousMessages(data.room);
        
        // Send previous messages to the new user
        if (previousMessages.length > 0) {
          ws.send(JSON.stringify({
            type: 'previousMessages',
            messages: previousMessages.map(msg => ({
              text: msg.message,
              sender: msg.username,
              timestamp: msg.timestamp
            }))
          }));
        }

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
        // Update room's last activity timestamp
        await updateRoomActivity(data.room);
        
        // Save message to MongoDB
        const newMessage = new Message({
          room: data.room,
          username: data.username,
          message: data.message
        });
        
        await newMessage.save();
        
        // Broadcast message to room
        broadcastToRoom(data.room, {
          type: 'message',
          username: data.username,
          message: data.message,
          timestamp: newMessage.timestamp
        });
      } else if (data.type === 'leave') {
        if (clientRoom && activeRooms.has(clientRoom)) {
          const roomClients = activeRooms.get(clientRoom);
          
          // Remove the client
          for (const client of roomClients) {
            if (client.ws === ws) {
              roomClients.delete(client);
              break;
            }
          }

          // If room is empty, delete it from memory (not from database)
          if (roomClients.size === 0) {
            activeRooms.delete(clientRoom);
          } else {
            // Broadcast updated user list
            broadcastToRoom(clientRoom, {
              type: 'userList',
              users: getActiveUsers(clientRoom)
            });
          }
        }
      }
    } catch (error) {
      console.error('Message handling error:', error);
    }
  });

  ws.on('close', () => {
    if (clientRoom && activeRooms.has(clientRoom)) {
      const roomClients = activeRooms.get(clientRoom);
      
      // Remove the disconnected client
      for (const client of roomClients) {
        if (client.ws === ws) {
          roomClients.delete(client);
          break;
        }
      }

      // If room is empty, delete it from memory (not from database)
      if (roomClients.size === 0) {
        activeRooms.delete(clientRoom);
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
    activeRooms: activeRooms.size
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