const axios = require('axios');

async function test() {
  console.log("Sending request to FastAPI...");
  try {
    const response = await axios.post(
      'https://mysawari-image-service.onrender.com/process',
      {
        input: 'https://res.cloudinary.com/duyuzd9ra/image/upload/q_auto,f_auto,w_800,c_limit/v1789556345/my-sawari/vehicles/vehicle-1789556344915-h6cjb6.jpg',
        operations: { privacy: { blur_car_plate: true } },
        output: { format: 'jpeg' }
      },
      {
        headers: { 'Content-Type': 'application/json' },
        responseType: 'arraybuffer',
        timeout: 120000
      }
    );
    console.log("SUCCESS! Got response of length:", response.data.length);
  } catch (err) {
    if (err.response) {
      console.log("ERROR STATUS:", err.response.status);
      console.log("ERROR DATA:", err.response.data ? Buffer.from(err.response.data).toString('utf-8') : null);
    } else {
      console.log("ERROR MESSAGE:", err.message);
    }
  }
}

test();
