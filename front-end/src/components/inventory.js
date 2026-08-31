//
// File: front-end/src/components/inventory.js
//
import React, { useState, useEffect } from "react";
import axios from 'axios';
import "./inventory.css";
//

const API_URL = process.env.REACT_APP_API_URL; //

// Inventory component to manage users ...
const Inventory = () => {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editUser, setEditUser] = useState(null);
  const [editForm, setEditForm] = useState({ firstname: '', lastname: '', email: '' });
  const [viewUser, setViewUser] = useState(null);
  const [deleteUser, setDeleteUser] = useState(null);
  //
  // Fetch users from the server ...
  const fetchUsers = async () => {
    try {
      const response = await axios.get(`${API_URL}/auth/inventory`, {
        withCredentials: true,
      });
      setUsers(response.data);
    } catch (error) {
      console.error("Error fetching users:", error);
    } finally {
      setLoading(false);
    }
  };
  //
  // Handle delete user ...
  const handleDelete = async (userId) => {
    try {
      await axios.delete(`http://localhost:5000/auth/inventory/${userId}`, {
        withCredentials: true,
      });
      // Log the success message to the console ...
      console.log(`User with ID ${userId} deleted successfully`);
      fetchUsers();
    } catch (error) {
      alert(`Error deleting user with ID ${userId}: ${error.message}`);
      console.error("Error deleting user:", error);
    }
  };
  //
  // Confirm delete user action ...
  const confirmDelete = (userId) => {
    setDeleteUser(userId);
  };
  //
  // Cancel delete action ...
  const cancelDelete = () => {
    setDeleteUser(null);
  };
  //
  // Open edit modal and populate form ...
  const handleEdit = (userId) => {
    const user = users.find(u => (u._id) === userId);
    setEditUser(user);
    setEditForm({
      firstname: user.firstname,
      lastname: user.lastname,
      email: user.email,
    });
  };
  //
  // Handle form input changes for editing user ...
  const handleEditChange = (e) => {
    setEditForm({ ...editForm, [e.target.name]: e.target.value });
  };
  //
  // Submit edit form to update user ...
  const handleEditSubmit = async (e) => {
    e.preventDefault();
    try {
      await axios.put(
        `http://localhost:5000/auth/inventory/${editUser._id}`, editForm,
        { withCredentials: true }
      );
      // Log the success message to the console ...
      console.log(`User with ID ${editUser._id} updated successfully`);
      setEditUser(null);
      fetchUsers();
    } catch (error) {
      alert(`Error updating user: ${error.message}`);
      console.error("Error updating user:", error);
    }
  };
  //
  // Close the edit modal and reset the form ...
  const closeEditModal = () => setEditUser(null);
  //
  // View function: set the selected user to viewUser state ...
  const handleView = (userId) => {
    const user = users.find(u => (u._id) === userId);
    setViewUser(user);
  };
  //
  // Close the modal for viewing user details ...
  const closeModal = () => setViewUser(null);
  //
  // Fetch users when the component mounts ...
  useEffect(() => {
    fetchUsers();
  }, []);
  //
  // Render the inventory component ...
  return (
    <div className="inventory-container">
      <h1 className="form-header" style={{ flex: 1, marginLeft: "20%" }}>User Management System</h1>
      <h2 className="inventory-header">User Inventory</h2>
      <button className="refresh-button" onClick={fetchUsers}>Refresh</button>
      {loading ? (
        <p>Loading users...</p>
      ) : users.length === 0 ? (
        <p>No users found.</p>
      ) : (
        <div className="table-wraper">
          <table className="user-table">
            {/*  */}
            <thead> 
              <tr>
                <th>Firstname</th>
                <th>Lastname</th>
                <th>Email</th>
                <th>Actions</th>
              </tr>
            </thead>
            {/*  */}
            <tbody>
              {users.map((user) => (
                <tr key={user._id}>
                  <td>{user.firstname}</td>
                  <td>{user.lastname}</td>
                  <td>{user.email}</td>
                  <td>
                    <div className="button-group">
                      <button className="delete-button" onClick={() => confirmDelete(user._id)}>Delete</button>
                      <button className="edit-button" onClick={() => handleEdit(user._id)}>Edit</button>
                      <button className="view-button" onClick={() => handleView(user._id)}>View</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            {/*  */}
          </table>
        </div>
      )}
      {/* View Modal */}
      {viewUser && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3>User Details</h3>
            <p><strong>Firstname:</strong> {viewUser.firstname}</p>
            <p><strong>Lastname:</strong> {viewUser.lastname}</p>
            <p><strong>Email:</strong> {viewUser.email}</p>
            <button onClick={closeModal}>Close</button>
          </div>
        </div>
      )}
      {/* Edit Modal */}
      {editUser && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3>Edit User</h3>
            <form onSubmit={handleEditSubmit}>
              <label>Firstname: <input type="text" name="firstname" value={editForm.firstname} onChange={handleEditChange} required/></label>
              <br />
              <label>Lastname: <input type="text" name="lastname" value={editForm.lastname} onChange={handleEditChange} required/></label>
              <br />
              <label>Email: <input type="email" name="email" value={editForm.email} onChange={handleEditChange} required/></label>
              <br />
              <button type="submit">Save</button>
              <button type="button" onClick={closeEditModal}>Cancel</button>
            </form>
          </div>
        </div>
      )}
      {/* Delete Confirmation Modal */}
      {deleteUser && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3>Confirm Deletion</h3>
            <p>Are you sure you want to delete this user?</p>
            <button onClick={() => {
              handleDelete(deleteUser);
              setDeleteUser(null);
            }}>Yes, Delete</button>
            <button onClick={cancelDelete}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Inventory;