const mongoose = require('mongoose');
const logger = require('../utils/logger');

const connectDB = async () => {
  // PRODUCTION: Require MONGODB_URI - fail if not set
  if (!process.env.MONGODB_URI) {
    throw new Error(
      '❌ CRITICAL ERROR: MONGODB_URI is not set in .env file\n' +
      'Please configure MongoDB Atlas and add MONGODB_URI to your .env file\n' +
      'Format: mongodb+srv://username:password@cluster.mongodb.net/dbname?retryWrites=true&w=majority'
    );
  }

  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 60000,
      connectTimeoutMS: 15000,
      retryWrites: true,
      maxPoolSize: 10,
    });
    logger.info(`MongoDB connected: ${conn.connection.host}`);
    return conn;
  } catch (error) {
    logger.error('MongoDB connection failed', { error: error.message });
    logger.error('Connection String (hidden password)', { uri: process.env.MONGODB_URI.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@') });
    
    // Helpful diagnostics
    if (error.name === 'MongooseServerSelectionError') {
      logger.error('DIAGNOSTICS:');
      logger.error('  1. Check that your IP is whitelisted in MongoDB Atlas (Network Access)');
      logger.error('  2. Make sure the username/password in MONGODB_URI is correct');
      logger.error('  3. Check if your network/firewall allows outbound connections to MongoDB Atlas');
      logger.error('  4. Try using the standard connection string instead of SRV:\n');
      logger.error('     mongodb://<username>:<password>@<cluster-host>:27017/<dbname>?retryWrites=true&w=majority&ssl=true');
    }
    throw error;
  }
};

module.exports = connectDB;
