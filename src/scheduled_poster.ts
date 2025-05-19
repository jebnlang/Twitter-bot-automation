import { config as dotenvConfig } from 'dotenv';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  preparePostData,
  publishTwitterPost,
  appendPostToLog,
  type PostLogEntry,
  type PreparedPostData
} from './post_writer'; // Assuming post_writer.ts is in the same directory

// Load environment variables
dotenvConfig();

// --- Constants ---
const HOURS_BETWEEN_POSTS = 6;
const MAX_TIME_VARIATION_MS = 30 * 60 * 1000; // 30 minutes in milliseconds
const MIN_TIME_BEFORE_FIRST_POST_MS = 0; // Was 5 * 60 * 1000 (5 minutes), now immediate
const GRACEFUL_EXIT_DELAY_MS = 2000; // 2 seconds delay before exiting

// --- Supabase Client ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// --- Deploy Mode Detection ---
// Check if this is the first run after deployment by setting env var
const IS_FIRST_RUN = process.env.IS_FIRST_RUN === 'true';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Scheduled Poster: Error - SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not defined.');
  process.exit(1);
}
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- Helper: Calculate Random Variation ---
function getRandomVariationMs(): number {
  return (Math.random() * 2 - 1) * MAX_TIME_VARIATION_MS;
}

// --- Main Orchestration Logic ---
async function main() {
  console.log('\n--- Scheduled Poster: Starting Run ---');
  let postPublishedInThisRun = false;
  let lastPostTimestampForScheduling: Date | null = null;
  let processedPostIdInThisRun: number | string | undefined = undefined; // Renamed for clarity

  try {
    // 1. Check for and process any due scheduled post
    const { data: readyPosts, error: fetchError } = await supabase
      .from('posts')
      .select('*')
      .eq('status', 'ready_to_post') // Using plain string
      .order('scheduled_time_utc', { ascending: true })
      .limit(1);

    if (fetchError) {
      console.error('Scheduled Poster: Error fetching ready posts:', fetchError);
    }

    if (readyPosts && readyPosts.length > 0) {
      const postToPublish = readyPosts[0] as PostLogEntry;
      processedPostIdInThisRun = postToPublish.id;
      const scheduledTime = new Date(postToPublish.scheduled_time_utc!);
      const now = new Date();

      console.log(`Scheduled Poster: Found a post "${postToPublish.topic || 'Untitled'}" (ID: ${postToPublish.id}) ready, scheduled for ${scheduledTime.toISOString()}`);

      if (scheduledTime <= now) {
        console.log(`Scheduled Poster: Scheduled time is now or past. Attempting to publish post ID ${postToPublish.id}.`);
        const postUrl = await publishTwitterPost(postToPublish.posted_text!);
        const currentTimeUTC = new Date().toISOString();

        if (postUrl) {
          await supabase
            .from('posts')
            .update({
              status: 'posted' as const,
              post_url: postUrl === "POSTED_SUCCESSFULLY" ? "https://x.com/posted-successfully" : postUrl,
              posted_at_utc: currentTimeUTC,
              error_message: null 
            })
            .eq('id', postToPublish.id!); 
          console.log(`Scheduled Poster: Successfully published post ID ${postToPublish.id}. ${postUrl === "POSTED_SUCCESSFULLY" ? "URL retrieval skipped." : `URL: ${postUrl}`}`);
          postPublishedInThisRun = true;
          lastPostTimestampForScheduling = new Date(currentTimeUTC);
        } else {
          await supabase
            .from('posts')
            .update({
              status: 'failed_to_post' as const,
              error_message: 'Publishing failed or URL not retrieved.',
              posted_at_utc: currentTimeUTC, 
            })
            .eq('id', postToPublish.id!); 
          console.error(`Scheduled Poster: Failed to publish post ID ${postToPublish.id}.`);
        }
      } else {
        console.log(`Scheduled Poster: Post ID ${postToPublish.id} is scheduled for ${scheduledTime.toISOString()}. Waiting.`);
        console.log('--- Scheduled Poster: Run Completed (Waiting for scheduled post) ---');
        await new Promise(resolve => setTimeout(resolve, GRACEFUL_EXIT_DELAY_MS));
        process.exit(0);
      }
    } else {
      console.log('Scheduled Poster: No posts currently marked 'ready_to_post' and due now.');
    }

    // 2. Prepare the next post if needed
    console.log('Scheduled Poster: Checking if a new post needs to be prepared...');
    const { data: anyReadyPosts, error: anyReadyError } = await supabase
      .from('posts')
      .select('id')
      .eq('status', 'ready_to_post') // Using plain string
      .limit(1);

    if (anyReadyError) {
      console.error('Scheduled Poster: Error checking for any existing ready posts:', anyReadyError);
    }

    let shouldPrepareNextPost = false;
    if (postPublishedInThisRun) {
      console.log('Scheduled Poster: A post was published in this run, preparing the next one.');
      shouldPrepareNextPost = true;
    } else if (!anyReadyPosts || anyReadyPosts.length === 0) {
      console.log('Scheduled Poster: No posts are currently 'ready_to_post'. Preparing a new one.');
      shouldPrepareNextPost = true;
    } else {
      console.log('Scheduled Poster: A post is already 'ready_to_post' for the future. No new preparation needed now.');
    }

    if (shouldPrepareNextPost) {
      console.log('Scheduled Poster: Initiating preparation of the next post...');
      try {
        if (!lastPostTimestampForScheduling) {
            const { data: lastSuccess, error: lastSuccessError } = await supabase
                .from('posts')
                .select('posted_at_utc')
                .eq('status', 'posted') // Using plain string for .eq()
                .order('posted_at_utc', { ascending: false })
                .limit(1);
            if (lastSuccessError) {
                console.error('Scheduled Poster: Error fetching last successful post time for scheduling next:', lastSuccessError);
            }
            if (lastSuccess && lastSuccess.length > 0 && lastSuccess[0].posted_at_utc) {
                lastPostTimestampForScheduling = new Date(lastSuccess[0].posted_at_utc);
                console.log(`Scheduled Poster: Last successful post was at ${lastPostTimestampForScheduling.toISOString()}`);
            }
        }

        let nextScheduledTimeUTC: Date;
        let isImmediateFirstPost = false; 

        if (lastPostTimestampForScheduling) {
            nextScheduledTimeUTC = new Date(lastPostTimestampForScheduling.getTime() + (HOURS_BETWEEN_POSTS * 60 * 60 * 1000) + getRandomVariationMs());
        } else {
            if (MIN_TIME_BEFORE_FIRST_POST_MS === 0 && !processedPostIdInThisRun) { 
                console.log('Scheduled Poster: First post run - scheduling for immediate posting.');
                nextScheduledTimeUTC = new Date(); 
                isImmediateFirstPost = true;
            } else {
                nextScheduledTimeUTC = new Date(Date.now() + MIN_TIME_BEFORE_FIRST_POST_MS + getRandomVariationMs());
            }
        }
        
        if (!isImmediateFirstPost && nextScheduledTimeUTC.getTime() < Date.now()) {
            console.warn('Scheduled Poster: Calculated next schedule time is in the past. Adjusting to a small delay from now.');
            nextScheduledTimeUTC = new Date(Date.now() + (1 * 60 * 1000) + Math.abs(getRandomVariationMs()));
        }

        console.log('Scheduled Poster: Calling preparePostData() for the next post...');
        const preparedData = await preparePostData();

        const newPostEntry: Partial<PostLogEntry> = {
          topic: preparedData.topic || undefined,
          posted_text: preparedData.postText || undefined,
          raw_openai_response: preparedData.rawOpenAIResponse || undefined,
          persona_alignment_check: preparedData.personaAlignmentCheck || undefined,
          scheduled_time_utc: nextScheduledTimeUTC.toISOString(),
        };
        
        if (preparedData.searchTopic) {
          console.log(`Scheduled Poster: Search topic used: "${preparedData.searchTopic}" to generate content about "${preparedData.topic || '[No Topic Yet]'}"`);
        }

        if (preparedData.success && preparedData.postText) {
          if (isImmediateFirstPost) {
            console.log(`Scheduled Poster: Immediate publishing mode for first ever post.`);
            newPostEntry.status = 'ready_to_post' as const; // Keep 'as const' for assignment
            console.log('Scheduled Poster: About to save immediate post as ready_to_post...');
            const { data: savedPost, error: saveError } = await supabase
              .from('posts').insert([newPostEntry]).select().single();
            
            if (saveError) {
              console.error('Scheduled Poster: Error saving immediate post before publishing:', saveError);
              throw saveError;
            }
            console.log(`Scheduled Poster: Immediate post saved (ID: ${savedPost.id}). Now publishing...`);
            
            const postUrl = await publishTwitterPost(savedPost.posted_text);
            const currentTimeUTC = new Date().toISOString();
            
            if (postUrl) {
              await supabase.from('posts').update({
                  status: 'posted' as const,
                  post_url: postUrl === "POSTED_SUCCESSFULLY" ? "https://x.com/posted-successfully" : postUrl,
                  posted_at_utc: currentTimeUTC, error_message: null 
              }).eq('id', savedPost.id);
              console.log(`Scheduled Poster: Successfully published immediate post (ID: ${savedPost.id}). ${postUrl === "POSTED_SUCCESSFULLY" ? "URL skip." : `URL: ${postUrl}`}`);
            } else {
              await supabase.from('posts').update({
                  status: 'failed_to_post' as const,
                  error_message: 'Immediate publishing failed.', posted_at_utc: currentTimeUTC
              }).eq('id', savedPost.id);
              console.error(`Scheduled Poster: Failed to publish immediate post (ID: ${savedPost.id}).`);
            }
          } else {
            newPostEntry.status = 'ready_to_post' as const; // Keep 'as const' for assignment
            console.log('Scheduled Poster: About to save next scheduled post as ready_to_post...');
            await appendPostToLog(newPostEntry);
            console.log(`Scheduled Poster: Successfully prepared and scheduled next post for ${nextScheduledTimeUTC.toISOString()}. Topic: "${preparedData.topic || '[No Topic Yet]'}".`);
          }
        } else {
          newPostEntry.status = 'generation_failed' as const;
          newPostEntry.error_message = preparedData.errorMessage || 'Unknown error during content generation.';
          console.log('Scheduled Poster: About to save post as generation_failed...');
          await appendPostToLog(newPostEntry);
          console.error(`Scheduled Poster: Failed to prepare content for the next post. Error: ${newPostEntry.error_message}`);
        }
      } catch (preparationError) {
        console.error('Scheduled Poster: CRITICAL ERROR during next post preparation phase:', preparationError);
      }
    }

  } catch (error) {
    console.error('Scheduled Poster: UNHANDLED CRITICAL ERROR in main execution block:', error);
  } finally {
    console.log('--- Scheduled Poster: Run Completed ---');
    // Only exit if not waiting for a future scheduled post.
    // If the logic reached a point where it decided to wait, it would have exited earlier.
    await new Promise(resolve => setTimeout(resolve, GRACEFUL_EXIT_DELAY_MS));
    process.exit(0);
  }
}

// --- Run Main Function ---
main(); 