//
// File: front-end/src/components/register.js
//
import React, { useState } from 'react';
import axios from 'axios';
import './register.css';


const API_URL = process.env.REACT_APP_API_URL;

// Register component to handle user registration ...
const Register = () => {
  const [firstname, setFirstname] = useState('');
  const [lastname, setLastname] = useState('');
  const [email, setEmail] = useState('');

  // This function handles the registration process ...
  const handleRegister = async (e) => {
    e.preventDefault(); // Prevent the default form submission behavior ...
    try {
      const response = await axios.post(
        `${API_URL}/auth/register`, // Ensure this URL matches the backend endpoint ...
        firstname && lastname && email ? { firstname, lastname, email } : {}, // Send the form data ...
        { withCredentials: true} // in case cookies are sent with the request ...
    );
    console.log('Registration successful!', response.data);
    alert("User registered Successfuly!");
     // Clear form fields after success ...
    setFirstname('');
    setLastname('');
    setEmail('');

    } catch (error) {
      console.error('Registration failed:', error);
    }
  };
  // This function handles input changes ...
  // It updates the state for firstname, lastname, and email ...
  // based on the input field that was changed ...
  const handleChange = (e) => {
    const { name, value } = e.target;
    switch (name) {
      case 'firstname':
        setFirstname(value);
        break;
      case 'lastname':
        setLastname(value);
        break;
      case 'email':
        setEmail(value);
        break;
      default:
        break;
    }
  }; 
  // The component renders a registration form ...
  return (
    <div className="register-container">
      <h1 className="form-header">User Management System</h1>
      <h2 className="register-header">Register User</h2>
      {/* <h2>Register</h2> */}
      <form onSubmit={handleRegister}>
        <input type="text" name="firstname" placeholder="Firstname" value={firstname} onChange={handleChange} required />
        <input type="text" name="lastname" placeholder="Lastname" value={lastname} onChange={handleChange} required />
        <input type="email" name="email" placeholder="Email" value={email} onChange={handleChange} required />
        <button type="submit">Register</button>
      </form>
    </div>
  );
};

export default Register;