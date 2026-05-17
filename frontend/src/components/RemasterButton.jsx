import React from "react";
import axios from "axios";

function RemasterButton({ trackId }) {
  const handleRemaster = async () => {
    try {
      const response = await axios.post(`http://127.0.0.1:8000/remaster/${trackId}`);
      alert(`Track ${trackId} remaster status: ${response.data.status}`);
    } catch (error) {
      console.error("Error sending remaster request:", error);
      alert("Failed to send remaster request.");
    }
  };

  return (
    <button onClick={handleRemaster} style={{ marginTop: "10px" }}>
      Remaster Track {trackId}
    </button>
  );
}

export default RemasterButton;
