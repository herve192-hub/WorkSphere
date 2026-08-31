//
// File: back-end/routes/authRoutes.js
//
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/user');
const mongoose = require('mongoose'); // Import mongoose to validate ObjectId format

const router = express.Router();
//
// POST /auth/Register ...
router.post('/register', async (req, res) => { // Define the route to register a new user ...
  
    try {
        const { firstname, lastname, email } = req.body;

        // const hashedPassword = await bcrypt.hash(password,10);
        const newUser = new User({
            firstname,
            lastname,
            email,
            // password: hashedPassword,
        });

        await newUser.save(); // Save the new user to the database ...
        console.log('User registered successfully:', newUser); // Log the success message to the console ...
        res.status(201).json({ 
            message: 'User registered successfully',
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ 
            message: 'Server error during registration',
        });
    }
});
//
// GET /auth/inventory ...
router.get('/inventory', async (req, res) => { // Define the route to fetch all users from database ...
  try {
    const users = await User.find();
    console.log('Users fetched successfully:', users);
    res.status(200).json(users);
  } catch (error) {
    console.error('Error fetching users data:', error.message);
    res.status(500).json({ 
      message: 'Server error while fetching users data',
      error: error.message
    });
  }
});
//
// DELETE /auth/inventory/:id ...
router.delete('/inventory/:id', async (req, res) => { // Define the route to delete a user by ID ...
  const userId = req.params.id; // Extract user ID from the request parameters ...
  try {
    // Validate the user ID format using mongoose.Types.ObjectId.isValid ...
    if (!mongoose.Types.ObjectId.isValid(userId)) {
          return res.status(400).json({
          message: 'Invalid user ID format',
        });
    }
    // Find the user by ID and delete them ...
    const deletedUser = await User.findByIdAndDelete(userId);
    if (!deletedUser) { // If no user was found with the given ID, return a 404 error ...
      return res.status(404).json({ 
        message: 'User not found',
      });
    }
    // If the user was successfully deleted, return a success message ...
    console.log('User deleted successfully:', deletedUser);
    res.status(200).json({
      message: 'User deleted successfully',
      user: deletedUser,
    });
  } catch (error) { // If an error occurs during the deletion process, log the error and return a 500 status ...
    console.error('Error deleting user:', error.message);
    res.status(500).json({ 
      message: 'Server error while deleting user',
      error: error.message
    });
  }
});
//
// GET /auth/inventory/:id - View a single user by ID
router.get('/inventory/:id', async (req, res) => { // Define the route to fetch a single user by ID ...
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      console.error('User not found:', req.params.id);
      return res.status(404).json({ message: 'User not found' });
    }
    // If the user is found, return the user data ...
    console.log('User fetched successfully:', user);
    res.status(200).json(user);
  } catch (error) {
    console.error('Error fetching user:', error.message);
    res.status(500).json({ message: 'Server error while fetching user', error: error.message });
  }
});
//
// PUT /auth/inventory/:id - Edit (update) a user by ID
router.put('/inventory/:id', async (req, res) => { // Define the route to update a user by ID ...
  try {
    const { firstname, lastname, email } = req.body;
    const updatedUser = await User.findByIdAndUpdate(
      req.params.id,
      { firstname, lastname, email },
      { new: true, runValidators: true }
    );
    if (!updatedUser) {
      console.error('User not found for update:', req.params.id);
      return res.status(404).json({ message: 'User not found' });
    }
    // If the user is successfully updated, return the updated user data ...
    console.log('User updated successfully:', updatedUser);
    res.status(200).json({ message: 'User updated successfully', user: updatedUser });
  } catch (error) {
    console.error('Error updating user:', error.message);
    res.status(500).json({ message: 'Server error while updating user', error: error.message });
  }
});

module.exports = router;