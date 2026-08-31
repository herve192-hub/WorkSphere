//
// back-end/config/db.js
//
const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config(); // Load environment variables from .env file ...

const connectMongoDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI); // Use the MONGO_URI from the .env file ...
    console.log('MongoDB connection established successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error);
  }
};
module.exports = connectMongoDB; // Export the connectMongoDB function for use in server.js ...
