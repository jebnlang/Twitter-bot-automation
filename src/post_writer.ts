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
const POST_WRITER_PERSONA_FILENAME = process.env.BRAIN_PERSONA_FILENAME || 'persona_2.md';
const HEADLESS_MODE = process.env.POST_WRITER_HEADLESS_MODE !== 'false'; // Default to true (headless)
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
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

  if (!fsSync.existsSync(authFilePath)) {
    console.log(`Post Writer Agent: auth.json not found at ${authFilePath}. Attempting to create from AUTH_JSON_BASE64 env var.`);
    if (AUTH_JSON_BASE64 && AUTH_JSON_BASE64.trim() !== '') {
      try {
        const authFileDir = pathUtil.dirname(authFilePath);
        if (!fsSync.existsSync(authFileDir)) {
          fsSync.mkdirSync(authFileDir, { recursive: true });
          console.log(`Post Writer Agent: Created directory ${authFileDir} for auth.json.`);
        }
        const decodedAuthJson = Buffer.from(AUTH_JSON_BASE64, 'base64').toString('utf-8');
        fsSync.writeFileSync(authFilePath, decodedAuthJson);
        console.log(`Post Writer Agent: Successfully created auth.json at ${authFilePath} from AUTH_JSON_BASE64.`);
      } catch (e: any) {
        console.error(`Post Writer Agent: Fatal error creating auth.json from AUTH_JSON_BASE64: ${e.message}`);
        console.error('Post Writer Agent: Please ensure AUTH_JSON_BASE64 is a valid base64 encoded string and the path is writable.');
        process.exit(1);
      }
    } else {
      console.error(`Post Writer Agent: Error - auth.json not found at ${authFilePath} and AUTH_JSON_BASE64 environment variable is not set or is empty.`);
      console.error('Post Writer Agent: Cannot proceed without authentication details. Please run authentication locally and provide AUTH_JSON_BASE64, or ensure the file is present if not using the environment variable.');
      process.exit(1);
    }
  } else {
    console.log(`Post Writer Agent: Using existing auth.json found at ${authFilePath}.`);
  }
}

if (!TAVILY_API_KEY) {
  console.error('Post Writer Agent: Error - TAVILY_API_KEY is not defined in your .env file.');
  process.exit(1);
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

// --- Tavily API Client (Direct REST API Calls) ---
// Simple wrapper functions for Tavily API calls
const tavilyApi = {
  async search(query: string, options: any = {}): Promise<any> {
    if (!TAVILY_API_KEY) {
      throw new Error('Tavily API Key is required');
    }

    try {
      const response = await axios.post('https://api.tavily.com/search', {
        api_key: TAVILY_API_KEY,
        query,
        search_depth: options.search_depth || 'basic',
        max_results: options.max_results || 5,
        include_images: options.include_images || false,
        include_answer: options.include_answer || false,
        include_raw_content: options.include_raw_content || false,
      });
      
      return response.data;
    } catch (error: any) {
      console.error('Tavily API Error:', error.response?.data || error.message);
      throw error;
    }
  }
};

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
  searchTopic: string | null;
  rawOpenAIResponse: object | null;
  personaAlignmentCheck: string | null;
  errorMessage?: string;
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
}

async function loadPreviousPosts(): Promise<Pick<PostLogEntry, 'posted_text' | 'topic'>[]> {
  try {
    const { data, error } = await supabase
      .from('posts')
      .select('posted_text, topic')
      .order('posted_at_utc', { ascending: false }) // IMPORTANT: Order by actual post time
      .limit(10); // Load last 10 posts for context

    if (error) {
      console.error('Post Writer Agent: Error loading previous posts from Supabase:', error);
      return [];
    }
    console.log(`Post Writer Agent: Loaded ${data.length} previous posts from Supabase.`);
    return data.map(p => ({ posted_text: p.posted_text || '', topic: p.topic }));
  } catch (error) {
    console.error('Post Writer Agent: Unexpected error loading previous posts from Supabase:', error);
    return [];
  }
}

// Updated to log more details to Supabase
async function appendPostToLog(newPostData: Partial<PostLogEntry>): Promise<void> { // Use Partial as not all fields always present
  try {
    // Ensure all fields map to new Supabase columns if needed
    // created_at is handled by Supabase default NOW()
    // scheduled_time_utc and posted_at_utc will be set explicitly by the scheduler when appropriate
    const { error } = await supabase.from('posts').insert([newPostData]);

    if (error) {
      console.error('Post Writer Agent: Error appending post to Supabase log:', error);
    } else {
      console.log('Post Writer Agent: Successfully appended new post to Supabase log');
    }
  } catch (error) {
    console.error('Post Writer Agent: Unexpected error appending post to Supabase log:', error);
  }
}

// --- Function to get a unique topic and fresh context ---
async function getUniqueTopicAndFreshContext(
  previousPosts: Pick<PostLogEntry, 'posted_text' | 'topic'>[]
): Promise<TopicContextResult> {
  console.log('Post Writer Agent: Attempting to find a unique topic and fresh context...');
  // Filter both null and undefined values
  const recentTopicsToAvoid = previousPosts.map(p => p.topic).slice(-7).filter(t => t !== undefined && t !== null) as string[];
  console.log('Post Writer Agent: Recent topics to avoid:', recentTopicsToAvoid);

  let attempts = 0;
  const maxAttempts = 5; // Increased from 3 to 5 for more flexibility with predetermined topics

  while (attempts < maxAttempts) {
    attempts++;
    console.log(`Post Writer Agent: Topic finding attempt ${attempts}/${maxAttempts}`);
    
    // Instead of hardcoded search queries, get a random topic from the search_topics table
    let searchTopic: string;
    try {
      // Fetch topics from search_topics table in random order
      // Exclude topics that have been recently used
      let { data: availableTopics, error } = await supabase
        .from('search_topics')
        .select('id, topic')
        .order('last_used_at', { ascending: true, nullsFirst: true }) // Prefer topics that haven't been used yet or used long ago
        .limit(10); // Get 10 topics to choose from
      
      if (error) {
        console.error('Post Writer Agent: Error fetching search topics from Supabase:', error);
        // Fallback to hardcoded topics if there's an error
        const fallbackTopics = [
          'latest news and trends in AI prompt engineering',
          'hot topics in large language models and prompting techniques',
          'breakthroughs in AI interaction and prompt crafting',
          'AI coding assistants and developer tools',
          'no-code platforms for AI application development'
        ];
        searchTopic = fallbackTopics[Math.floor(Math.random() * fallbackTopics.length)];
        console.log(`Post Writer Agent: Using fallback search topic: "${searchTopic}"`);
      } else if (!availableTopics || availableTopics.length === 0) {
        console.error('Post Writer Agent: No search topics found in database, using fallback');
        searchTopic = 'latest news and trends in AI prompt engineering';
      } else {
        // Filter out recently used topics
        const filteredTopics = availableTopics.filter(t => 
          !recentTopicsToAvoid.some(avoid => 
            avoid?.toLowerCase().includes(t.topic.toLowerCase()) || 
            t.topic.toLowerCase().includes(avoid?.toLowerCase())
          )
        );
        
        if (filteredTopics.length === 0) {
          // If all topics have been recently used, just pick a random one from the original list
          console.log('Post Writer Agent: All topics have been recently used, selecting random topic anyway');
          const randomTopic = availableTopics[Math.floor(Math.random() * availableTopics.length)];
          searchTopic = randomTopic.topic;
        } else {
          // Pick a random topic from the filtered list
          const randomTopic = filteredTopics[Math.floor(Math.random() * filteredTopics.length)];
          searchTopic = randomTopic.topic;
          
          // Update the last_used_at timestamp for this topic
          await supabase
            .from('search_topics')
            .update({ last_used_at: new Date().toISOString() })
            .eq('id', randomTopic.id);
        }
        console.log(`Post Writer Agent: Selected search topic: "${searchTopic}"`);
      }
    } catch (topicError) {
      console.error('Post Writer Agent: Error selecting search topic:', topicError);
      searchTopic = 'latest news and trends in AI prompt engineering'; // Fallback
    }
    
    let broadSearchResults;
    try {
      console.log(`Post Writer Agent: Performing Tavily search using topic: "${searchTopic}"`);
      const tavilyResponse = await tavilyApi.search(searchTopic, {
        search_depth: "basic",
        max_results: 7,
      });
      broadSearchResults = tavilyResponse.results; 

      if (!broadSearchResults || broadSearchResults.length === 0) {
        console.warn('Post Writer Agent: Tavily search returned no results.');
        if (attempts === maxAttempts) return { topic: null, searchContext: null };
        await new Promise(resolve => setTimeout(resolve, 1500)); 
        continue;
      }
    } catch (searchError) {
      console.error('Post Writer Agent: Error during Tavily search:', searchError);
      if (attempts === maxAttempts) return { topic: null, searchContext: null };
      await new Promise(resolve => setTimeout(resolve, 1500));
      continue;
    }

    const candidateTopics: string[] = broadSearchResults
      .map((result: any) => result.title)
      .filter((title: string | null): title is string => title !== null && title.trim() !== '');

    if (candidateTopics.length === 0) {
      console.warn('Post Writer Agent: Could not extract any candidate topics from Tavily search results.');
      if (attempts === maxAttempts) return { topic: null, searchContext: null };
      continue; 
    }

    for (const candidateTopic of candidateTopics) {
      // Add null safety with optional chaining
      if (!recentTopicsToAvoid.some(avoid => avoid?.toLowerCase() === candidateTopic.toLowerCase())) {
        console.log(`Post Writer Agent: Found unique candidate topic from search: "${candidateTopic}"`);
        
        console.log(`Post Writer Agent: Performing focused Tavily search on topic: "${candidateTopic}"`);
        try {
          const focusedTavilyResponse = await tavilyApi.search(candidateTopic, {
            search_depth: "advanced",
            max_results: 5,
            include_answer: false,
            include_raw_content: false,
            include_images: false, 
          });
          const focusedSearchResults = focusedTavilyResponse.results;

          if (!focusedSearchResults || focusedSearchResults.length === 0) {
            console.warn(`Post Writer Agent: Tavily focused search for "${candidateTopic}" returned no results.`);
            continue; 
          }

          const formattedFocusedSearchContext = focusedSearchResults
            .map((r: any, i: number) => `Relevant Information Source ${i+1}: "${r.title}"\nURL: ${r.url}\nContent: ${r.content}`)
            .join('\n\n---\n');
          
          console.log(`Post Writer Agent: Successfully gathered focused context for "${candidateTopic}" from Tavily.`);
          
          // Important: Return both the refined candidate topic AND the original search topic
          // This ensures we know which predefined topic from our table generated this content
          return { 
            topic: candidateTopic, 
            searchContext: formattedFocusedSearchContext,
            originalSearchTopic: searchTopic // Add this as part of the return type
          };

        } catch (focusedSearchError) {
          console.error(`Post Writer Agent: Error during Tavily focused search for topic "${candidateTopic}":`, focusedSearchError);
          continue; 
        }
      }
    }
    console.warn('Post Writer Agent: All candidate topics from this search were similar to recent posts or focused search failed. Retrying with different search topic if attempts left.');
  }

  console.warn('Post Writer Agent: Could not find a unique topic and gather focused context after max attempts with Tavily.');
  return { topic: null, searchContext: null };
}

// --- Update the TopicContextResult interface to include the original search topic ---
interface TopicContextResult {
  topic: string | null;
  searchContext: string | null;
  originalSearchTopic?: string; // Add this to store which topic from our table was used
}

// --- OpenAI Content Generation ---
async function generateNewPost(persona: string, previousPostTexts: string[], currentTopic: string, searchContext: string): Promise<{ tweet: string | null; generatedTopic: string | null; rawOpenAIResponseForLog: object | null; personaAlignmentCheckForLog: string | null }> {
  console.log(`Post Writer Agent: Generating new post on topic "${currentTopic}" with OpenAI...`);
  let promptContent = `Your primary goal is to embody the following Twitter persona. Adhere to it strictly.
--- PERSONA START ---
${persona}
--- PERSONA END ---

Based on this persona, you need to draft a new, original tweet. The tweet should be insightful, valuable, and sound human—like an experienced builder sharing knowledge, not a marketing department.

--- EXAMPLES OF TWEET STYLE ---
GOOD EXAMPLE (Adheres to Persona):
Tweet: "After a decade debugging distributed systems, the one constant is change. Embrace observability, not just as a tool, but as a mindset. Know your state."
Reasoning: This tweet is good because it shares an experienced insight, uses a confident and direct tone, and avoids marketing language, hashtags, and questions.

BAD EXAMPLE (Violates Persona):
Tweet: "🚀 Excited to announce our new AI-powered widget! It will revolutionize your workflow! #AI #Innovation. Thoughts?"
Reasoning: This tweet is bad because it uses emojis excessively, marketing hype, hashtags, and ends with a question, all violating the persona rules.
--- END EXAMPLES OF TWEET STYLE ---

Key rules to follow for THIS TWEET:
1.  DO NOT ask any questions, especially at the end of the tweet. No exceptions.
2.  DO NOT use hashtags.
3.  DO NOT use em dashes (—).
4.  AVOID marketing hype, overly enthusiastic language, or corporate-sounding phrases. Focus on authenticity and genuine insight.
5.  Ensure the tweet is fresh and unique, and not too similar in topic or phrasing to the previously posted tweets listed below.
6.  DO NOT mention Teleprompt or its features in this tweet. The product description in the persona is only context, not content.
7.  Maximize readability with short, punchy sentences and **ensure you use double line breaks (\n\n) between paragraphs or distinct ideas to create visual spacing, similar to the provided example image.**
8.  **AIM FOR A LENGTH OF AROUND 600 CHARACTERS (approximately 3-5 substantial paragraphs) to provide in-depth, insightful, and educational content.**
9.  **The primary topic for this tweet should be: "${currentTopic}".** Draw inspiration and information from the 'RECENT WEB SEARCH CONTEXT' provided below.
`;

  promptContent += '\n--- RECENT WEB SEARCH CONTEXT (for relevance and inspiration) ---\n';
  promptContent += searchContext;
  promptContent += '\n--- END RECENT WEB SEARCH CONTEXT ---\n';


  if (previousPostTexts.length > 0) {
    promptContent += '\n--- PREVIOUSLY POSTED TWEETS (for ensuring originality) ---';
    previousPostTexts.slice(-5).forEach((text, index) => {
      promptContent += `\nPrevious Post ${index + 1}: ${text}`;
    });
    promptContent += '\n--- END PREVIOUSLY POSTED TWEETS ---';
  }

  promptContent += `
--- INSTRUCTIONS FOR YOUR RESPONSE ---
Before you provide the final tweet, first write a short (1-2 sentence) 'Persona Alignment Check:' where you briefly explain how your planned tweet aligns with the core persona attributes and the given topic.

Next, on a new line, clearly starting with 'Generated Topic:', provide the main topic of the tweet you are about to write. This should closely match or be a refinement of the provided topic: "${currentTopic}".

Then, on a new line, clearly starting with 'Tweet:', provide ONLY the tweet text.

Example of response format:
Persona Alignment Check: This tweet reflects an experienced builder sharing a direct observation on [topic], avoids hype and questions.
Generated Topic: [Main topic of the tweet]
Tweet: [Your carefully crafted tweet text here]
--- END INSTRUCTIONS FOR YOUR RESPONSE ---

Now, draft the new tweet based on all the above instructions.
`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: "You are an AI assistant strictly following a detailed persona and set of rules to draft a unique, insightful, and well-structured Twitter post of approximately 600 characters on a given topic, using provided web search context. Your main job is to adhere to all constraints, especially regarding tone, style, length, paragraph structure (double line breaks), providing a persona alignment check, explicitly stating the generated topic, and avoiding questions." },
        { role: 'user', content: promptContent },
      ],
      max_tokens: 450, // Adjusted for topic, context, alignment check + ~600 char tweet
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

  // Main posting loop with retries
  while (retryCount <= maxRetries) {
    try {
      console.log(`Post Writer Agent: Navigation attempt ${retryCount + 1}/${maxRetries + 1} to Twitter compose page...`);
      
      // Increased timeout for initial page load
      await page.goto('https://x.com/compose/post', { waitUntil: 'networkidle', timeout: 120000 });
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
        'div[data-testid="tweetTextInput_0"]'
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
        'div[role="button"][data-testid="tweetButtonInline"]'
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
      
      // Consider post successful even if we can't confirm URL
      console.log('Post Writer Agent: Post likely successful. Will attempt to get URL...');
      
      // Try to get post URL but don't make it critical
      try {
        const profileLink = await page.locator('a[data-testid="AppTabBar_Profile_Link"]').getAttribute('href');
        if (profileLink) {
          console.log(`Post Writer Agent: Navigating to profile ${profileLink} to find post URL.`);
          await page.goto(`https://x.com${profileLink}`, { waitUntil: 'networkidle', timeout: 60000});
          
          console.log('Post Writer Agent: Waiting for tweets to appear on profile page...');
          await page.waitForSelector('article[data-testid="tweet"]', { state: 'visible', timeout: 30000 });
          
          const firstTweetLink = await page.locator('article[data-testid="tweet"] a:has(time[datetime])').first().getAttribute('href');
          if (firstTweetLink) {
            postUrl = `https://x.com${firstTweetLink}`;
            console.log(`Post Writer Agent: Found post URL: ${postUrl}`);
          }
        }
      } catch (urlError) {
        console.log('Post Writer Agent: Could not retrieve post URL, but post was likely successful.');
      }
      
      // Successfully completed the posting process
      break;
      
    } catch (error: any) {
      console.error(`Post Writer Agent: Error during attempt ${retryCount + 1}:`, error);
      
      // Save a screenshot for debugging
      try {
        const screenshotPath = `/data/error_screenshot_${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath });
        console.log(`Post Writer Agent: Saved error screenshot to ${screenshotPath}`);
      } catch (screenshotError) {
        console.log('Post Writer Agent: Could not save error screenshot:', screenshotError);
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

// --- NEW Main Data Preparation Function ---
async function preparePostData(): Promise<PreparedPostData> {
  console.log('--- Post Writer Agent: Starting Data Preparation ---');

  await loadPostWriterPersona();

  const previousPostsFromDb = await loadPreviousPosts();
  const previousPostContext = previousPostsFromDb.map(p => ({ posted_text: p.posted_text, topic: p.topic }));

  const topicResult = await getUniqueTopicAndFreshContext(previousPostContext);
  const { topic: currentTopic, searchContext, originalSearchTopic } = topicResult;

  if (!currentTopic || !searchContext) {
    console.error('Post Writer Agent: Could not determine a unique topic or fetch search context during data preparation.');
    return {
      success: false,
      postText: null,
      topic: null,
      searchTopic: null,
      rawOpenAIResponse: null,
      personaAlignmentCheck: null,
      errorMessage: 'Could not determine a unique topic or fetch search context.'
    };
  }

  let newPostText: string | null = null;
  let finalGeneratedTopicForLog: string | null = null;
  let rawOpenAIResponseForLog: object | null = null;
  let personaAlignmentCheckForLog: string | null = null;
  const maxRetries = 3; // Retries for OpenAI generation

  for (let i = 0; i < maxRetries; i++) {
    console.log(`Post Writer Agent: Attempt ${i + 1} to generate new post data on topic: "${currentTopic}".`);
    const previousPostTextsOnly = previousPostContext.map(p => p.posted_text || '');
    const generationResult = await generateNewPost(postWriterPersonaContent, previousPostTextsOnly, currentTopic, searchContext);
    
    newPostText = generationResult.tweet;
    finalGeneratedTopicForLog = generationResult.generatedTopic || currentTopic;
    rawOpenAIResponseForLog = generationResult.rawOpenAIResponseForLog;
    personaAlignmentCheckForLog = generationResult.personaAlignmentCheckForLog;

    if (newPostText) {
      console.log(`Post Writer Agent: Successfully generated post content for topic "${finalGeneratedTopicForLog}"`);
      console.log(`Post Writer Agent: Original search topic: "${originalSearchTopic}"`);
      return {
        success: true,
        postText: newPostText,
        topic: finalGeneratedTopicForLog,
        searchTopic: originalSearchTopic || null,
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
  console.error(`Post Writer Agent: Failed to generate new post data for topic "${finalGeneratedTopicForLog || currentTopic}" after multiple attempts.`);
  return {
    success: false,
    postText: null,
    topic: finalGeneratedTopicForLog || currentTopic,
    searchTopic: originalSearchTopic || null,
    rawOpenAIResponse: rawOpenAIResponseForLog,
    personaAlignmentCheck: personaAlignmentCheckForLog,
    errorMessage: 'Failed to generate post content after multiple attempts.'
  };
}

export {
  preparePostData,
  publishTwitterPost,
  appendPostToLog, // Exporting for the scheduler to use
  type PostLogEntry, // Exporting the type for the scheduler
  type PreparedPostData // Exporting the type for clarity if used by scheduler
};