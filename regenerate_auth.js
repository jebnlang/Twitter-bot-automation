const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Configuration
const AUTH_FILE_PATH = path.join(__dirname, 'auth.json');
const HEADLESS = false; // Set to false to see the browser

async function regenerateAuth() {
  console.log('Starting browser to authenticate with Twitter...');
  
  const browser = await chromium.launch({ 
    headless: HEADLESS,
    args: ['--window-size=1280,960']
  });
  
  const context = await browser.newContext({
    viewport: { width: 1280, height: 960 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
  });
  
  const page = await context.newPage();
  
  try {
    // Navigate to Twitter
    console.log('Navigating to Twitter login page...');
    await page.goto('https://twitter.com/login', { waitUntil: 'load' });
    
    console.log('\n\n=============================================');
    console.log('MANUAL AUTHENTICATION REQUIRED');
    console.log('=============================================');
    console.log('1. Please log in to your Twitter account in the browser window');
    console.log('2. After successful login, the script will save the authentication state');
    console.log('3. Press any key in this terminal when you have successfully logged in');
    console.log('=============================================\n\n');
    
    // Wait for manual login
    await new Promise(resolve => {
      process.stdin.once('data', data => {
        resolve();
      });
    });
    
    // Verify login by checking for a profile element
    try {
      console.log('Verifying login status...');
      
      // Navigate to the home page to verify login
      await page.goto('https://twitter.com/home', { waitUntil: 'load' });
      await page.waitForTimeout(5000); // Let the page load completely
      
      // Check if we're logged in by looking for home timeline
      const isLoggedIn = await page.locator('div[aria-label="Home timeline"]').count()
        .then(() => true)
        .catch(() => false);
      
      if (!isLoggedIn) {
        console.log('Could not verify Twitter login. Please try again and ensure you are fully logged in.');
        return;
      }
      
      console.log('Login verified successfully!');
      
      // Save authentication state
      const storageState = await context.storageState();
      fs.writeFileSync(AUTH_FILE_PATH, JSON.stringify(storageState, null, 2));
      console.log(`Authentication data saved to ${AUTH_FILE_PATH}`);
      
    } catch (error) {
      console.error('Error verifying login:', error);
    }
    
  } catch (error) {
    console.error('Error during authentication process:', error);
  } finally {
    await browser.close();
    console.log('Browser closed. Process complete.');
  }
}

regenerateAuth(); 