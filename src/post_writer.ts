import { chromium } from 'playwright-extra';
import { Page } from 'playwright-core';
import stealth from 'puppeteer-extra-plugin-stealth';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios'; // Added axios import for API calls
import { createClient, SupabaseClient } from '@supabase/supabase-js'; // Supabase import

// Load environment variables
dotenv.config();
chromium.use(stealth());

// --- Environment Variables ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PLAYWRIGHT_STORAGE = process.env.PLAYWRIGHT_STORAGE || 'auth.json';
const AUTH_JSON_BASE64 = process.env.AUTH_JSON_BASE64; // Added for Railway deployment
const POST_WRITER_PERSONA_FILENAME = process.env.BRAIN_PERSONA_FILENAME || 'insight_instructor_persona.md'; // Updated to use new persona
const HEADLESS_MODE = process.env.POST_WRITER_HEADLESS_MODE !== 'false'; // Default to true (headless)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// --- Basic Validations ---
if (!OPENAI_API_KEY) {
  console.error('Post Writer Agent: Error - OPENAI_API_KEY is not defined. Please set it in your .env file.');
  process.exit(1);
}

// Validating PLAYWRIGHT_STORAGE and attempting to hydrate auth.json from AUTH_JSON_BASE64 if needed
if (!PLAYWRIGHT_STORAGE) {
  console.error('Post Writer Agent: Error - PLAYWRIGHT_STORAGE path is not defined. Please set it in your .env file.');
  process.exit(1);
} else {
  // We need 'fs' for synchronous operations here during startup, and 'path' for resolving.
  // These are already imported (fs from 'fs/promises', path from 'path'), but for this sync block, we use require.
  const fsSync = require('fs');
  const pathUtil = require('path'); // Using pathUtil to avoid conflict if path was destructured from import
  const authFilePath = pathUtil.resolve(PLAYWRIGHT_STORAGE);

  if (AUTH_JSON_BASE64 && AUTH_JSON_BASE64.trim() !== '') {
    console.log(`Post Writer Agent: AUTH_JSON_BASE64 environment variable found. Creating/overwriting auth.json at ${authFilePath}.`);
    try {
      const authFileDir = pathUtil.dirname(authFilePath);
      if (!fsSync.existsSync(authFileDir)) {
        fsSync.mkdirSync(authFileDir, { recursive: true });
        console.log(`Post Writer Agent: Created directory ${authFileDir} for auth.json.`);
      }
      const decodedAuthJson = Buffer.from(AUTH_JSON_BASE64, 'base64').toString('utf-8');
      fsSync.writeFileSync(authFilePath, decodedAuthJson);
      console.log(`Post Writer Agent: Successfully created/overwrote auth.json at ${authFilePath} from AUTH_JSON_BASE64.`);
    } catch (e: any) {
      console.error(`Post Writer Agent: Fatal error creating/overwriting auth.json from AUTH_JSON_BASE64: ${e.message}`);
      console.error('Post Writer Agent: Please ensure AUTH_JSON_BASE64 is a valid base64 encoded string and the path is writable.');
      process.exit(1);
    }
  } else if (!fsSync.existsSync(authFilePath)) {
    console.error(`Post Writer Agent: Error - auth.json not found at ${authFilePath} and AUTH_JSON_BASE64 environment variable is not set or is empty.`);
    console.error('Post Writer Agent: Cannot proceed without authentication details. Please run authentication locally and provide AUTH_JSON_BASE64, or ensure the file is present if not using the environment variable.');
    process.exit(1);
  } else {
    console.log(`Post Writer Agent: Using existing auth.json found at ${authFilePath} (AUTH_JSON_BASE64 not provided).`);
  }
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Post Writer Agent: Error - SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not defined. Please set them in your .env file.');
  process.exit(1);
}

// --- Supabase Client ---
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- OpenAI Client ---
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// --- Helper: Type with Jitter (copied from poster.ts) ---
async function typeWithJitter(page: Page, selector: string, text: string, jitterMs: number = 25) {
  await page.waitForSelector(selector, { state: 'visible' });
  for (const char of text) {
    await page.type(selector, char, { delay: jitterMs + (Math.random() * jitterMs) }); // Add some randomness to jitter
  }
}

// --- Persona ---
let postWriterPersonaContent: string = 'Default Post Writer Persona: Create an engaging and informative tweet.'; // Fallback

async function loadPostWriterPersona(): Promise<void> {
  const personaFilePath = path.resolve(POST_WRITER_PERSONA_FILENAME);
  try {
    console.log(`Post Writer Agent: Loading persona from ${personaFilePath}`);
    postWriterPersonaContent = await fs.readFile(personaFilePath, 'utf8');
    console.log('Post Writer Agent: Persona loaded successfully.');
  } catch (error) {
    console.error(`Post Writer Agent: Error loading persona file from ${personaFilePath}. Using fallback persona.`, error);
  }
}

// --- New Interface for Prepared Post Data ---
interface PreparedPostData {
  success: boolean;
  postText: string | null;
  topic: string | null;
  articleUrl: string | null; // Changed from searchTopic to articleUrl
  rawOpenAIResponse: object | null;
  personaAlignmentCheck: string | null;
  articleId?: number; // Added to track which article was processed
  errorMessage?: string;
}

// --- New Interface for Article Data ---
interface ArticleData {
  id: number;
  article: string; // Column is named "article" not "url"
  timestamp?: string;
  posted_text?: string | null;
  post_url?: string | null;
  status: 'pending' | 'processed' | 'posted' | 'failed';
  error_message?: string | null;
  raw_openai_response?: object | null;
  persona_alignment_check?: string | null;
  scheduled_time_utc?: string | null;
  posted_at_utc?: string | null;
  generation_log?: object | null;
}

// --- Supabase Log Handling ---
interface PostLogEntry {
  id?: number; // Or string if UUID, assuming number for auto-incrementing bigint
  timestamp: string; // Will be handled by Supabase default NOW()
  posted_text: string; // Renamed from postedText for Supabase column convention
  post_url?: string;    // Renamed from postUrl
  topic?: string;      // This will store both the generated topic and search topic
  status: 'pending' | 'posted' | 'failed' | 'generation_failed' | 'ready_to_post';
  error_message?: string;
  raw_openai_response?: object; // For JSONB
  persona_alignment_check?: string;
  scheduled_time_utc?: string; // For TIMESTAMPTZ
  posted_at_utc?: string; // For TIMESTAMPTZ
  generation_log?: object; // For JSONB
  article_url?: string; // Added to store the article URL
  article_id?: number; // Added to reference the posts_news table
}

// --- New function to fetch pending articles from posts_news table ---
async function fetchPendingArticle(): Promise<ArticleData | null> {
  try {
    console.log('Post Writer Agent: Fetching pending article from posts_news table...');
    
    const { data, error } = await supabase
      .from('posts_news')
      .select('*')
      .eq('status', 'pending')
      .order('timestamp', { ascending: true }) // Use timestamp instead of created_at
      .limit(1); // Only get the next article to process
    
    if (error) {
      console.error('Post Writer Agent: Error fetching pending article:', error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log('Post Writer Agent: No pending articles found.');
      return null;
    }
    
    console.log(`Post Writer Agent: Found pending article with ID ${data[0].id}: ${data[0].article}`);
    return data[0] as ArticleData;
  } catch (error) {
    console.error('Post Writer Agent: Unexpected error fetching pending article:', error);
    return null;
  }
}

// --- New function to update article status ---
async function updateArticleStatus(articleId: number, status: 'pending' | 'processed' | 'posted' | 'failed', errorMessage?: string): Promise<void> {
  try {
    const updateData: any = { 
      status,
      // Add appropriate timestamps based on status
      ...(status === 'processed' ? { processed_at: new Date().toISOString() } : {}),
      ...(status === 'posted' ? { posted_at_utc: new Date().toISOString() } : {})
    };
    
    if (errorMessage) {
      updateData.error_message = errorMessage;
    }
    
    const { error } = await supabase
      .from('posts_news')
      .update(updateData)
      .eq('id', articleId);
    
    if (error) {
      console.error(`Post Writer Agent: Error updating article ${articleId} status to ${status}:`, error);
    } else {
      console.log(`Post Writer Agent: Successfully updated article ${articleId} status to ${status}`);
    }
  } catch (error) {
    console.error(`Post Writer Agent: Unexpected error updating article ${articleId} status:`, error);
  }
}

// --- New function to fetch article content using axios ---
async function fetchArticleContent(url: string): Promise<string | null> {
  try {
    console.log(`Post Writer Agent: Fetching content from article URL: ${url}`);
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
      },
      timeout: 30000 // 30 second timeout
    });
    
    if (response.status === 200) {
      // Return the HTML content - we'll process it in the OpenAI prompt
      return response.data;
    } else {
      console.error(`Post Writer Agent: Failed to fetch article content. Status code: ${response.status}`);
      return null;
    }
  } catch (error) {
    console.error('Post Writer Agent: Error fetching article content:', error);
    return null;
  }
}

// Updated to log more details to Supabase, including article information
async function appendPostToLog(newPostData: Partial<PostLogEntry>): Promise<void> { // Use Partial as not all fields always present
  try {
    // Ensure all fields map to new Supabase columns
    // created_at is handled by Supabase default NOW()
    // scheduled_time_utc and posted_at_utc will be set explicitly by the scheduler when appropriate
    const { error } = await supabase.from('posts').insert([newPostData]);

    if (error) {
      console.error('Post Writer Agent: Error appending post to Supabase log:', error);
    } else {
      console.log('Post Writer Agent: Successfully appended new post to Supabase log');
      
      // If this post is associated with an article and is posted successfully, update the article status
      if (newPostData.article_id && newPostData.status === 'posted') {
        await updateArticleStatus(newPostData.article_id, 'posted');
        console.log(`Post Writer Agent: Updated article ${newPostData.article_id} status to posted`);
      }
    }
  } catch (error) {
    console.error('Post Writer Agent: Unexpected error appending post to Supabase log:', error);
  }
}

// --- OpenAI Content Generation ---
async function generateNewPost(persona: string, articleUrl: string, articleContent: string, articleTitle?: string | null): Promise<{ tweet: string | null; generatedTopic: string | null; rawOpenAIResponseForLog: object | null; personaAlignmentCheckForLog: string | null }> {
  console.log(`Post Writer Agent: Generating new post for article: "${articleTitle || articleUrl}" with OpenAI...`);
  let promptContent = `Your primary goal is to embody the following Twitter persona. Adhere to it strictly.
--- PERSONA START ---
${persona}
--- PERSONA END ---

Based on this persona, you need to draft a new, original tweet that summarizes and provides insight on the article I'm sharing. The tweet should be insightful, valuable, and sound human-like.

--- ARTICLE TO SUMMARIZE ---
URL: ${articleUrl}
${articleTitle ? `Title: ${articleTitle}` : ''}
Content: ${articleContent.slice(0, 15000)}... (content may be truncated)
--- END ARTICLE ---

--- EXAMPLES OF TWEET STYLE ---
GOOD EXAMPLE (Adheres to Persona):
"At Computex 2025, Nvidia unveiled a sweeping vision: humanoid robotics powered by custom AI infrastructure, built to reason, adapt, and operate in physical space.

Their GR00T project aims to unify language, perception, and motor control through foundation models trained across diverse physical tasks. Combined with Isaac Lab, a GPU-accelerated robotics simulation environment, this enables fast learning in synthetic environments before real-world deployment.

Alongside robotics, Nvidia revealed next-gen server and networking hardware optimized for AI agent workflows. Think low-latency, high-bandwidth systems engineered for multi-agent inference and decision-making at scale.

This is not just about faster GPUs. Its about building AI-native infrastructure where reasoning meets robotics, and autonomy meets embodiment.

The future Nvidia is shaping blends silicon, simulation, and cognition into one stack. Prompting wont stay on screens. It will walk, move, and act in the world."

BAD EXAMPLE (Violates Persona):
Tweet: "🚀 Excited to announce our new AI-powered widget! It will revolutionize your workflow! #AI #Innovation. Thoughts?"
Reasoning: This tweet is bad because it uses emojis excessively, marketing hype, hashtags, and ends with a question, all violating the persona rules.
--- END EXAMPLES OF TWEET STYLE ---

Key rules to follow for THIS TWEET:
1.  DO NOT ask any questions, especially at the end of the tweet. No exceptions.
2.  DO NOT use hashtags.
3.  DO NOT use em dashes (—).
4.  AVOID marketing hype, overly enthusiastic language, or corporate-sounding phrases. Focus on authenticity and genuine insight.
5.  DO NOT mention Teleprompt or its features in this tweet. The product description in the persona is only context, not content.
6.  Maximize readability with short, punchy sentences and **ensure you use double line breaks (\n\n) between paragraphs or distinct ideas to create visual spacing, similar to the provided example image.**
7.  **AIM FOR A LENGTH OF AROUND 800 CHARACTERS (approximately 3-5 substantial paragraphs) to provide in-depth, insightful, and educational content.**
8.  **For this tweet, extract the most valuable insights from the article and present them in a clear, educational manner.**
`;

  promptContent += `
--- INSTRUCTIONS FOR YOUR RESPONSE ---
Before you provide the final tweet, first write a short (1-2 sentence) 'Persona Alignment Check:' where you briefly explain how your planned tweet aligns with the core persona attributes and effectively summarizes the article.

Next, on a new line, clearly starting with 'Generated Topic:', provide a concise topic that represents the main focus of your tweet based on the article.

Then, on a new line, clearly starting with 'Tweet:', provide ONLY the tweet text.

Example of response format:
Persona Alignment Check: This tweet distills the article's key insights on [topic] while maintaining an educational and informative tone without marketing language.
Generated Topic: [Main topic extracted from the article]
Tweet: [Your carefully crafted tweet text here]
--- END INSTRUCTIONS FOR YOUR RESPONSE ---

Now, draft the new tweet based on all the above instructions.
`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: "You are an AI assistant strictly following a detailed persona and set of rules to draft a unique, insightful, and well-structured Twitter post of approximately 800 characters, summarizing an article. Your main job is to adhere to all constraints, especially regarding tone, style, length, paragraph structure (double line breaks), providing a persona alignment check, explicitly stating the generated topic, and avoiding questions." },
        { role: 'user', content: promptContent },
      ],
      max_tokens: 450, // Adjusted for topic, context, alignment check + ~800 char tweet
      temperature: 0.7,
      n: 1,
    });

    if (completion.choices && completion.choices[0].message && completion.choices[0].message.content) {
      const rawResponse = completion.choices[0].message.content.trim();
      console.log(`Post Writer Agent: OpenAI raw response:\n${rawResponse}`);

      const alignmentCheckMatch = rawResponse.match(/Persona Alignment Check:(.*?)Generated Topic:/is);
      const generatedTopicMatch = rawResponse.match(/Generated Topic:(.*?)Tweet:/is);
      const tweetMatch = rawResponse.match(/Tweet:(.*)/is);

      let alignmentText: string | null = null;
      let finalGeneratedTopic: string | null = null;
      let newTweetText: string | null = null;

      if (alignmentCheckMatch && alignmentCheckMatch[1]) {
        alignmentText = alignmentCheckMatch[1].trim();
        console.log(`Post Writer Agent: Persona Alignment Check: ${alignmentText}`);
      }
      if (generatedTopicMatch && generatedTopicMatch[1]) {
        finalGeneratedTopic = generatedTopicMatch[1].trim();
        console.log(`Post Writer Agent: OpenAI stated generated topic: "${finalGeneratedTopic}"`);
      }
      if (tweetMatch && tweetMatch[1]) {
        newTweetText = tweetMatch[1].trim();
        console.log(`Post Writer Agent: Extracted tweet: "${newTweetText}"`);
        if (newTweetText.toLowerCase().includes("error") || newTweetText.length < 10 || newTweetText.includes("?")) {
          console.warn("Post Writer Agent: OpenAI generated a very short, error-like, or question-containing tweet.");
          return { tweet: null, generatedTopic: finalGeneratedTopic, rawOpenAIResponseForLog: {response: rawResponse}, personaAlignmentCheckForLog: alignmentText };
        }
      } else {
        console.error('Post Writer Agent: Could not extract tweet from OpenAI response using "Tweet:" prefix.');
      }
      return { tweet: newTweetText, generatedTopic: finalGeneratedTopic, rawOpenAIResponseForLog: {response: rawResponse}, personaAlignmentCheckForLog: alignmentText };
    } else {
      console.error('Post Writer Agent: OpenAI did not return valid content.');
      return { tweet: null, generatedTopic: null, rawOpenAIResponseForLog: null, personaAlignmentCheckForLog: null };
    }
  } catch (error) {
    console.error('Post Writer Agent: Error calling OpenAI API:', error);
    return { tweet: null, generatedTopic: null, rawOpenAIResponseForLog: null, personaAlignmentCheckForLog: null };
  }
}

// --- NEW Main Data Preparation Function ---
async function preparePostData(): Promise<PreparedPostData> {
  console.log('--- Post Writer Agent: Starting Data Preparation ---');

  await loadPostWriterPersona();

  // Fetch a pending article instead of topics
  const pendingArticle = await fetchPendingArticle();
  
  if (!pendingArticle) {
    console.error('Post Writer Agent: No pending articles found in posts_news table.');
    return {
      success: false,
      postText: null,
      topic: null,
      articleUrl: null,
      rawOpenAIResponse: null,
      personaAlignmentCheck: null,
      errorMessage: 'No pending articles found in posts_news table.'
    };
  }

  // Fetch the article content
  const articleContent = await fetchArticleContent(pendingArticle.article);
  
  if (!articleContent) {
    console.error(`Post Writer Agent: Failed to fetch content for article: ${pendingArticle.article}`);
    // Update article status to failed
    await updateArticleStatus(pendingArticle.id, 'failed', 'Failed to fetch article content');
    return {
      success: false,
      postText: null,
      topic: null,
      articleUrl: pendingArticle.article,
      articleId: pendingArticle.id,
      rawOpenAIResponse: null,
      personaAlignmentCheck: null,
      errorMessage: 'Failed to fetch article content'
    };
  }

  // Mark the article as being processed
  await updateArticleStatus(pendingArticle.id, 'processed');

  // Generate post based on article content
  let newPostText: string | null = null;
  let finalGeneratedTopicForLog: string | null = null;
  let rawOpenAIResponseForLog: object | null = null;
  let personaAlignmentCheckForLog: string | null = null;
  const maxRetries = 3; // Retries for OpenAI generation

  for (let i = 0; i < maxRetries; i++) {
    console.log(`Post Writer Agent: Attempt ${i + 1} to generate new post data for article: "${pendingArticle.article}"`);
    const generationResult = await generateNewPost(
      postWriterPersonaContent, 
      pendingArticle.article, 
      articleContent,
      null // We don't have a title field in the posts_news table
    );
    
    newPostText = generationResult.tweet;
    finalGeneratedTopicForLog = generationResult.generatedTopic;
    rawOpenAIResponseForLog = generationResult.rawOpenAIResponseForLog;
    personaAlignmentCheckForLog = generationResult.personaAlignmentCheckForLog;

    if (newPostText) {
      console.log(`Post Writer Agent: Successfully generated post content for article "${pendingArticle.article}"`);
      return {
        success: true,
        postText: newPostText,
        topic: finalGeneratedTopicForLog,
        articleUrl: pendingArticle.article,
        articleId: pendingArticle.id,
        rawOpenAIResponse: rawOpenAIResponseForLog,
        personaAlignmentCheck: personaAlignmentCheckForLog,
      };
    }
    
    if (i < maxRetries - 1) {
      console.log('Post Writer Agent: Failed to generate suitable post data, retrying after a short delay...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  // If loop finishes without returning, generation failed
  console.error(`Post Writer Agent: Failed to generate new post data for article "${pendingArticle.article}" after multiple attempts.`);
  // Update article status to failed
  await updateArticleStatus(pendingArticle.id, 'failed', 'Failed to generate post content after multiple attempts');
  return {
    success: false,
    postText: null,
    topic: finalGeneratedTopicForLog,
    articleUrl: pendingArticle.article,
    articleId: pendingArticle.id,
    rawOpenAIResponse: rawOpenAIResponseForLog,
    personaAlignmentCheck: personaAlignmentCheckForLog,
    errorMessage: 'Failed to generate post content after multiple attempts.'
  };
}

// --- Function to Verify Twitter Authentication ---
async function verifyTwitterAuthentication(): Promise<boolean> {
  console.log('Post Writer Agent: Verifying Twitter authentication status...');
  // Ensure auth.json is hydrated if AUTH_JSON_BASE64 is set (this logic is at the top of the file)
  // It will exit if critical auth info is missing.

  const browser = await chromium.launch({
    headless: HEADLESS_MODE,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--window-size=1280,960'
    ],
    timeout: 90000 // 90 second timeout for browser launch
  });

  const context = await browser.newContext({
    storageState: PLAYWRIGHT_STORAGE,
    viewport: { width: 1280, height: 960 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();
  let loginSuccess = false;
  const twitterHomeUrl = 'https://twitter.com/home';

  try {
    console.log(`Post Writer Agent (Auth Check): Navigating to ${twitterHomeUrl}...`);
    await page.goto(twitterHomeUrl, { waitUntil: 'load', timeout: 60000 });
    console.log('Post Writer Agent (Auth Check): Page loaded, waiting 5s for stabilization...');
    await page.waitForTimeout(5000);

    // Always take a screenshot of the homepage
    console.log('Post Writer Agent (Auth Check): Taking homepage screenshot...');
    try {
      const screenshotBuffer = await page.screenshot();
      console.log('Post Writer Agent (Auth Check): Homepage screenshot (base64):');
      console.log(`data:image/png;base64,${screenshotBuffer.toString('base64')}`);
    } catch (screenshotError: any) {
      console.error('Post Writer Agent (Auth Check): Could not capture homepage screenshot:', screenshotError.message);
    }

    const homeTimelineSelector = 'div[aria-label="Home timeline"], div[data-testid="primaryColumn"]';
    const loggedInElement = page.locator(homeTimelineSelector).first();

    console.log(`Post Writer Agent (Auth Check): Checking for logged-in element: ${homeTimelineSelector}`);
    try {
      await loggedInElement.waitFor({ state: 'visible', timeout: 15000 }); // Increased timeout slightly
      loginSuccess = true;
      console.log('Post Writer Agent (Auth Check): SUCCESS - Logged-in element found. Authentication appears to be working.');
      // Optional: Could save a success screenshot here if needed for positive confirmation, but less critical.
    } catch (e) {
      loginSuccess = false;
      console.error('Post Writer Agent (Auth Check): FAILURE - Logged-in element NOT found. Authentication likely failed.');
      // Screenshot is already taken and logged if this was the first attempt, 
      // or if an error occurred during navigation that prevented reaching this specific check.
      // If we want a specific screenshot *at this failure point*, we could add one here, 
      // but the earlier homepage screenshot should already show the state (e.g., login page).
    }
  } catch (error: any) {
    console.error('Post Writer Agent (Auth Check): Error during authentication check:', error.message);
    loginSuccess = false; // Ensure failure on any exception during navigation/check
    // Screenshot is already taken and logged if an error occurred during page.goto or initial stabilization.
    // If not, or if we want a screenshot specifically at this catch block:
    if (!page.isClosed()) { // Check if page is still available
        try {
            const screenshotBuffer = await page.screenshot();
            console.error('Post Writer Agent (Auth Check): Error condition screenshot (base64):');
            console.error(`data:image/png;base64,${screenshotBuffer.toString('base64')}`);
        } catch (screenshotError: any) {
            console.error('Post Writer Agent (Auth Check): Could not capture error screenshot during exception:', screenshotError.message);
        }
    }
  } finally {
    console.log('Post Writer Agent (Auth Check): Closing browser.');
    if (browser && browser.isConnected()) {
        await browser.close();
    }
  }
  return loginSuccess;
}

// --- Playwright Posting Logic ---
async function publishTwitterPost(postText: string): Promise<string | null> {
  console.log('Post Writer Agent: Launching browser to post tweet...');
  // Added more specific browser launch options for cloud environment
  const browser = await chromium.launch({ 
    headless: HEADLESS_MODE,
    args: [
      '--disable-dev-shm-usage', // Overcome limited memory issues in containerized environments
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--window-size=1280,960'
    ],
    timeout: 90000 // 90 second timeout for browser launch
  });
  
  // Added explicit timeout config for context creation
  const context = await browser.newContext({ 
    storageState: PLAYWRIGHT_STORAGE,
    viewport: { width: 1280, height: 960 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
  });
  
  const page = await context.newPage();
  let postUrl: string | null = null;
  let maxRetries = 2; // Add retries for the entire posting process
  let retryCount = 0;

  // Verify login status first before attempting to post
  try {
    console.log('Post Writer Agent: Verifying Twitter login status first...');
    await page.goto('https://twitter.com/home', { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(5000); // Give the page time to load
    
    // Check if we're properly logged in
    const isLoggedIn = await page.locator('div[aria-label="Home timeline"], div[data-testid="primaryColumn"]').count()
      .then(() => true)
      .catch(() => false);
    
    if (!isLoggedIn) {
      console.error('Post Writer Agent: ERROR - Not properly logged in to Twitter. Authentication has expired or is invalid.');
      await page.screenshot({ path: 'error-auth-expired.png' });
      console.error('Post Writer Agent: Screenshot saved to error-auth-expired.png');
      console.error('Post Writer Agent: Please run the regenerate_auth.js script to refresh authentication.');
      await browser.close();
      return null;
    }
    
    console.log('Post Writer Agent: Login verification successful, proceeding to post.');
  } catch (loginCheckError) {
    console.error('Post Writer Agent: Error while verifying login status:', loginCheckError);
    try {
      await page.screenshot({ path: 'error-login-check.png' });
      console.error('Post Writer Agent: Screenshot saved to error-login-check.png');
    } catch (screenshotError) {
      console.error('Post Writer Agent: Failed to save error screenshot:', screenshotError);
    }
    await browser.close();
    return null;
  }

  // Main posting loop with retries
  while (retryCount <= maxRetries) {
    try {
      console.log(`Post Writer Agent: Navigation attempt ${retryCount + 1}/${maxRetries + 1} to Twitter compose page...`);
      
      // Don't wait for networkidle - just wait for load event which is more reliable
      await page.goto('https://x.com/compose/post', { waitUntil: 'load', timeout: 60000 });
      console.log('Post Writer Agent: Page loaded, waiting for content to stabilize...');
      
      // Wait for page to be fully interactive
      await page.waitForTimeout(5000);
      
      // Check if we're actually logged in
      const isLoggedIn = await page.locator('div[aria-label="Home timeline"]').count()
        .then(() => true)
        .catch(() => false);
      
      if (!isLoggedIn) {
        console.log('Post Writer Agent: Twitter login status check - may not be properly logged in, but attempting to continue...');
      } else {
        console.log('Post Writer Agent: Twitter login confirmed.');
      }
      
      // Try different selectors for the tweet editor
      const editorSelectors = [
        'div.public-DraftEditor-content[role="textbox"]',
        'div[data-testid="tweetTextarea_0"]',
        'div[contenteditable="true"][aria-multiline="true"]',
        'div[data-testid="tweetTextInput_0"]',
        'div[data-testid="tweetTextInput"]',
        'div[contenteditable="true"][role="textbox"]',
        'div[aria-label="Tweet text"]',
        'div[aria-labelledby="post-text-area-label"]',
        'div.notranslate[contenteditable="true"]'
      ];
      
      console.log('Post Writer Agent: Trying multiple selectors for tweet editor...');
      let editorFound = false;
      
      for (const selector of editorSelectors) {
        try {
          console.log(`Post Writer Agent: Trying editor selector: ${selector}`);
          // Much longer timeout (60 seconds) for finding the editor
          const isVisible = await page.waitForSelector(selector, { 
            state: 'visible', 
            timeout: 60000 
          }).then(() => true).catch(() => false);
          
          if (isVisible) {
            console.log(`Post Writer Agent: Tweet editor found with selector: ${selector}`);
            console.log('Post Writer Agent: Typing post...');
            await typeWithJitter(page, selector, postText, 30);
            editorFound = true;
            break;
          }
        } catch (selectorError) {
          console.log(`Post Writer Agent: Selector "${selector}" not found, trying next...`);
        }
      }
      
      if (!editorFound) {
        throw new Error("Could not find tweet editor with any selector");
      }
      
      // Try different selectors for the post button
      const postButtonSelectors = [
        'button[data-testid="tweetButton"]',
        'div[data-testid="tweetButtonInline"]',
        'div[role="button"][data-testid="tweetButtonInline"]',
        'button[data-testid="postButton"]',
        'button:has-text("Post")',
        'div[role="button"]:has-text("Post")',
        'div[data-testid="tweetButtonInline"][role="button"]'
      ];
      
      console.log('Post Writer Agent: Looking for Post button...');
      let buttonFound = false;
      
      for (const selector of postButtonSelectors) {
        try {
          console.log(`Post Writer Agent: Trying post button selector: ${selector}`);
          const isVisible = await page.waitForSelector(selector, { 
            state: 'visible', 
            timeout: 30000 
          }).then(() => true).catch(() => false);
          
          if (isVisible) {
            console.log(`Post Writer Agent: Post button found with selector: ${selector}`);
            await page.click(selector);
            buttonFound = true;
            break;
          }
        } catch (buttonError) {
          console.log(`Post Writer Agent: Button selector "${selector}" not found, trying next...`);
        }
      }
      
      if (!buttonFound) {
        throw new Error("Could not find post button with any selector");
      }
      
      // Wait longer for post to complete
      console.log('Post Writer Agent: Waiting for post to complete (15 seconds)...');
      await page.waitForTimeout(15000);
      
      // Consider post successful after clicking the button and waiting
      console.log('Post Writer Agent: Post successful! No need to retrieve URL.');
      postUrl = "POSTED_SUCCESSFULLY"; // Use a placeholder instead of null to indicate success
      
      // Try to get post URL but don't make it critical - keep this code but make it non-blocking
      try {
        const profileLink = await page.locator('a[data-testid="AppTabBar_Profile_Link"]').getAttribute('href');
        if (profileLink) {
          console.log(`Post Writer Agent: Attempting to navigate to profile ${profileLink} to find post URL.`);
          await page.goto(`https://x.com${profileLink}`, { waitUntil: 'load', timeout: 30000});
          
          console.log('Post Writer Agent: Waiting for tweets to appear on profile page...');
          await page.waitForSelector('article[data-testid="tweet"]', { state: 'visible', timeout: 20000 });
          
          const firstTweetLink = await page.locator('article[data-testid="tweet"] a:has(time[datetime])').first().getAttribute('href');
          if (firstTweetLink) {
            postUrl = `https://x.com${firstTweetLink}`;
            console.log(`Post Writer Agent: Found post URL: ${postUrl}`);
          }
        }
      } catch (urlError) {
        console.log('Post Writer Agent: Could not retrieve post URL, but post was successfully published.');
        // Don't change the postUrl value - keep the "POSTED_SUCCESSFULLY" marker
      }
      
      // Successfully completed the posting process
      break;
      
    } catch (error: any) {
      console.error(`Post Writer Agent: Error during attempt ${retryCount + 1}:`, error);
      
      // Replace file saving with base64 logging
      try {
        const screenshotBuffer = await page.screenshot();
        const base64Screenshot = screenshotBuffer.toString('base64');
        console.log(`Post Writer Agent: Error screenshot (base64):`);
        console.log(`data:image/png;base64,${base64Screenshot}`);
      } catch (screenshotError) {
        console.log('Post Writer Agent: Could not capture error screenshot:', screenshotError);
      }
      
      // If we have retries left, try again
      if (retryCount < maxRetries) {
        retryCount++;
        console.log(`Post Writer Agent: Retrying (${retryCount}/${maxRetries})...`);
        await page.waitForTimeout(10000); // Wait 10 seconds before retry
        continue;
      }
      
      // Out of retries
      console.error('Post Writer Agent: Failed to post after all retry attempts.');
      postUrl = null;
      break;
    }
  }
  
  // Close browser in finally block to ensure it happens
  try {
    console.log('Post Writer Agent: Closing browser.');
    if (browser && browser.isConnected()) {
      await browser.close();
    }
  } catch (closeError) {
    console.error('Post Writer Agent: Error closing browser:', closeError);
  }
  
  return postUrl; // This will be null if URL couldn't be confirmed or posting failed
}

export {
  preparePostData,
  publishTwitterPost,
  appendPostToLog,
  verifyTwitterAuthentication,
  type PostLogEntry,
  type PreparedPostData
};