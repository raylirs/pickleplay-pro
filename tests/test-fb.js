const userToken = 'EAAWWZB2sZCj98BScJhoHUJ6ZBhjKpR572BCZBJK6DT5gl1sd67nqlng5KjnEPvG4fxXtT3YlUpTTdygzsR3nRMVx9Ht37Wz4AwcZCx2aXxQNnnAZCTiQBPUhBsKAAqHwGkX5ZCoeL3h8i9dyj6yEi5pHhoZCTovdGLpuiwxztqUOthwzZBZADsJrY5fHiVFzzsH5kCLdF5kEBCbt1JjTj5Rfe28jezNxZBGHZCNzx2I5eTV6Ft0dRf7K0e5hoA2pUfiGFos26AIndJb1Cit10NeL';
const targetPageId = '1224751467396635'; // 3KS Reservation

async function testFacebookNotification() {
  console.log('=====================================================');
  console.log('🧪 TESTING FACEBOOK META NOTIFICATION INTEGRATION');
  console.log('=====================================================');

  // 1. Get User info
  console.log('[Step 1] Verifying User Token for Ryan Kristoffer Liray...');
  const meRes = await fetch(`https://graph.facebook.com/v24.0/me?access_token=${userToken}`);
  const meData = await meRes.json();
  console.log('User Profile:', meData);

  // 2. Fetch all Pages and get the specific Page Access Token for 3KS Reservation
  console.log('\n[Step 2] Fetching Page Access Token for 3KS Reservation...');
  const pagesRes = await fetch(`https://graph.facebook.com/v24.0/me/accounts?fields=id,name,access_token,category&access_token=${userToken}`);
  const pagesData = await pagesRes.json();

  if (pagesData.error) {
    console.error('Failed to fetch pages:', pagesData.error.message);
    return;
  }

  const targetPage = pagesData.data.find(p => p.id === targetPageId) || pagesData.data.find(p => p.name.includes('3KS'));
  if (!targetPage) {
    console.error(`Page with ID ${targetPageId} not found in user accounts. Available pages:`, pagesData.data.map(p => `${p.name} (${p.id})`));
    return;
  }

  console.log(`Found Page: "${targetPage.name}" (ID: ${targetPage.id})`);
  const pageAccessToken = targetPage.access_token;
  console.log('Page Access Token extracted successfully.');

  // 3. Fetch conversations
  console.log('\n[Step 3] Checking conversations in "' + targetPage.name + '" inbox...');
  const convRes = await fetch(`https://graph.facebook.com/v24.0/${targetPage.id}/conversations?fields=id,updated_time,snippet,participants&access_token=${pageAccessToken}`);
  const convData = await convRes.json();

  if (convData.error) {
    console.error('Conversation Error:', convData.error.message);
    return;
  }

  const conversations = convData.data || [];
  console.log(`Found ${conversations.length} conversation(s) in inbox.`);

  if (conversations.length > 0) {
    for (const conv of conversations) {
      console.log('\nConversation ID:', conv.id, '| Last snippet:', conv.snippet);
      const participants = conv.participants ? conv.participants.data : [];
      const recipient = participants.find(p => p.id !== targetPage.id);

      if (recipient) {
        console.log(`\n[Step 4] Sending live test alert to ${recipient.name} (PSID: ${recipient.id})...`);
        const sendRes = await fetch(`https://graph.facebook.com/v24.0/me/messages?access_token=${pageAccessToken}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: { id: recipient.id },
            message: {
              text: `🏓 [3KS PLAYGROUND LIVE TEST]\n\nHello ${recipient.name}! Your Facebook Meta Messenger notification system is 100% CONNECTED & WORKING!\n\n📅 Date: ${new Date().toLocaleDateString()}\n🏟️ Facility: 3KS Pickleball Playground`
            }
          })
        });

        const sendResult = await sendRes.json();
        console.log('Send Result:', sendResult);

        if (sendResult.recipient_id && sendResult.message_id) {
          console.log(`\n🎉 SUCCESS! Alert delivered to ${recipient.name} on Messenger! Message ID: ${sendResult.message_id}`);
        } else if (sendResult.error) {
          console.error('Delivery Error:', sendResult.error.message);
        }
      }
    }
  } else {
    console.log('\n⚠️ No messages in "3KS Reservation" inbox yet.');
    console.log('👉 ACTION: Open Messenger and send any message (e.g. "Hi") to 3KS Reservation at: https://m.me/1224751467396635');
    console.log('As soon as you send 1 message to the page, run this test to receive your alert!');
  }
}

testFacebookNotification();
