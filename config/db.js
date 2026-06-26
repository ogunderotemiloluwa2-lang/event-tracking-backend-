const mongoose = require('mongoose');

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
    console.log(`✅ MongoDB connected: ${conn.connection.host}`);
    return conn;
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    console.error('🔗 Connection String (hidden password):', process.env.MONGODB_URI.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@'));
    
    // Helpful diagnostics
    if (error.name === 'MongooseServerSelectionError') {
      console.error('\n📋 DIAGNOSTICS:');
      console.error('  1. Check that your IP is whitelisted in MongoDB Atlas (Network Access)');
      console.error('  2. Make sure the username/password in MONGODB_URI is correct');
      console.error('  3. Check if your network/firewall allows outbound connections to MongoDB Atlas');
      console.error('  4. Try using the standard connection string instead of SRV:\n');
      console.error('     mongodb://<username>:<password>@<cluster-host>:27017/<dbname>?retryWrites=true&w=majority&ssl=true');
    }
    throw error;
  }
};

module.exports = connectDB;
