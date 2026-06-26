require('dotenv').config();
const dns = require('dns');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const connectDB = require('./config/db');

// Force DNS to use Google's servers for reliable MongoDB SRV resolution
// Some ISP/network DNS servers (including Windows) fail to resolve mongodb+srv:// TXT records
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1']);

const app = express();

// Configure multer for file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(upload.single('file')); // Handle single file uploads

// Routes
app.use('/api/events', require('./routes/events'));
app.use('/api/attendees', require('./routes/attendees'));
app.use('/api/auth', require('./routes/auth'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'Server is running' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Internal server error', error: err.message });
});

const PORT = process.env.PORT || 5000;

// Async startup function
async function startServer() {
  try {
    console.log('🔄 Connecting to MongoDB...');
    await connectDB();
    
    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      console.log(`📍 API: http://localhost:${PORT}/api`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
}

startServer();
