//
// File: front-end/src/components/sidebar.js
//
import { Link } from 'react-router-dom';
import './sidebar.css';

const Sidebar = () => {
  return (
    <div className="sidebar-container">
      <h2>Navigation</h2>

      <Link to="/register" className="sidebar-link">
        <button className="sidebar-button">Add User</button>
      </Link>

      <Link to="/inventory" className="sidebar-link">
        <button className="sidebar-button">User Inventory</button>
      </Link>
    </div>
  );
};

export default Sidebar;