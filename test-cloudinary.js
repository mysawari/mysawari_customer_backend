const axios = require('axios');
axios.get("https://res.cloudinary.com/duyuzd9ra/image/upload/q_auto,f_auto,w_800,c_limit/v1789556345/my-sawari/vehicles/vehicle-1789556344915-h6cjb6.jpg", {
  responseType: 'arraybuffer',
  timeout: 10000,
  maxRedirects: 2,
})
.then(() => console.log('SUCCESS'))
.catch(e => console.log('ERROR:', e.message));
