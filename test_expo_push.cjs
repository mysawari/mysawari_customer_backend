const fetch = require('node-fetch');

(async () => {
  const token = 'ExponentPushToken[i2ZpNuNmoKHKGRhbn2Vf0w]';
  const payload = {
    to: token,
    sound: 'default',
    title: 'Test Delivery',
    body: 'Testing Expo Push Delivery',
    priority: 'high',
    channelId: 'default',
  };

  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify([payload]),
    });
    const json = await res.json();
    console.log("Response from Expo:", JSON.stringify(json, null, 2));

    // If success, get the receipt to see if FCM failed downstream
    if (json.data && json.data[0].status === 'ok') {
      const ticketId = json.data[0].id;
      console.log(`\nTicket ID received: ${ticketId}. Waiting 5 seconds to fetch receipt...`);
      await new Promise(r => setTimeout(r, 5000));

      const receiptRes = await fetch('https://exp.host/--/api/v2/push/getReceipts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ids: [ticketId] }),
      });
      const receiptJson = await receiptRes.json();
      console.log("Receipt from Expo:", JSON.stringify(receiptJson, null, 2));
    }

  } catch (e) {
    console.error("Error:", e);
  }
})();
