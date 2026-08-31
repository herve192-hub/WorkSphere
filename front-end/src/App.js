//
// File: front-end/src/App.js
//
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Register from "./components/register";
import Inventory from "./components/inventory";
import SideBar from "./components/sidebar";

const App = () => {
  return (
    <Router>
      <div className="app-container" style={{ display: "block" }}>
        <SideBar />
        <div className="main-content" style={{ flex: 1, marginLeft: "200px" }}>
          <div className="content" style={{ padding: "20px" }}>
            <Routes>
              <Route path="/register" element={<Register />} />
              <Route path="/inventory" element={<Inventory />} />
            </Routes>
          </div>
        </div>
      </div>
    </Router>
  );
};

export default App;
