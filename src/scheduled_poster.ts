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
const MIN_TIME_BEFORE_FIRST_POST_MS = 5 * 60 * 1000; // 5 minutes for the very first post or after a long gap

// --- Supabase Client ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

  // 1. Check for an existing post that is ready and scheduled to be posted
  const initialStatusFilter: PostLogEntry['status'] = 'ready_to_post';
  const { data: readyPosts, error: fetchError } = await supabase
    .from('posts')
    .select('*') // Select all columns for the ready post
    .eq('status', initialStatusFilter)
    .order('scheduled_time_utc', { ascending: true })
    .limit(1);

  if (fetchError) {
    console.error('Scheduled Poster: Error fetching ready posts:', fetchError);
    // Decide if to proceed or exit. For now, let's try to prepare a new one if fetching failed.
  }

  let postPublishedInThisRun = false;
  let lastPostTimestampForScheduling: Date | null = null;

  if (readyPosts && readyPosts.length > 0) {
    const postToPublish = readyPosts[0] as PostLogEntry;
    const scheduledTime = new Date(postToPublish.scheduled_time_utc!);
    const now = new Date();

    console.log(`Scheduled Poster: Found a post "${postToPublish.topic || 'Untitled'}" ready, scheduled for ${scheduledTime.toISOString()}`);

    if (scheduledTime <= now) {
      console.log(`Scheduled Poster: Scheduled time is now or past. Attempting to publish post ID ${postToPublish.id} (Topic: ${postToPublish.topic}).`);
      
      const postUrl = await publishTwitterPost(postToPublish.posted_text!);
      const currentTimeUTC = new Date().toISOString();

      if (postUrl) {
        await supabase
          .from('posts')
          .update({
            status: 'posted' as const,
            post_url: postUrl,
            posted_at_utc: currentTimeUTC,
            error_message: null 
          })
          .eq('id', postToPublish.id!);
        console.log(`Scheduled Poster: Successfully published post ID ${postToPublish.id}. URL: ${postUrl}`);
        postPublishedInThisRun = true;
        lastPostTimestampForScheduling = new Date(currentTimeUTC); // Use the actual publish time for next schedule
      } else {
        await supabase
          .from('posts')
          .update({
            status: 'failed_to_post' as const,
            error_message: 'Publishing failed or URL not retrieved.',
            posted_at_utc: currentTimeUTC, // Log attempt time
          })
          .eq('id', postToPublish.id!);
        console.error(`Scheduled Poster: Failed to publish post ID ${postToPublish.id}.`);
        // Even if publishing failed, we might want to schedule a new one based on the *intended* schedule of this failed one.
        // Or, more simply, use the last *successful* post as the basis.
        // For now, if a publish fails, we'll rely on the next section to schedule a new one based on the last SUCCESSFUL post.
      }
    } else {
      console.log(`Scheduled Poster: Post ID ${postToPublish.id} is scheduled for ${scheduledTime.toISOString()}. Waiting.`);
      // If the next post is scheduled for the future, we don't need to prepare another one yet.
      // The current design implies one 'ready_to_post' at a time.
      console.log('--- Scheduled Poster: Run Completed (Waiting for scheduled post) ---');
      return; // Exit early
    }
  }

  // 2. If no post was found ready, or if a post was just published, prepare the next one.
  // We check if a 'ready_to_post' already exists to avoid creating duplicates if the previous section exited early.
  const statusToFilter: PostLogEntry['status'] = 'ready_to_post';
  const { data: existingReadyCheck, error: existingReadyError } = await supabase
    .from('posts')
    .select('id')
    .eq('status', statusToFilter)
    .limit(1);

  if (existingReadyError) {
    console.error('Scheduled Poster: Error checking for existing ready posts before preparation:', existingReadyError);
    // Potentially exit or handle, for now, proceed with caution
  }

  if (existingReadyCheck && existingReadyCheck.length > 0 && !postPublishedInThisRun) {
    console.log("Scheduled Poster: A post is already marked 'ready_to_post' and was not published in this run. Skipping new preparation.");
  } else {
    console.log('Scheduled Poster: Preparing data for the next post...');
    const preparedData = await preparePostData();
    
    // Determine the schedule for this new post
    if (!lastPostTimestampForScheduling) { // If no post was published in this run, get the last successful post time
        const { data: lastSuccess, error: lastSuccessError } = await supabase
            .from('posts')
            .select('posted_at_utc')
            .eq('status', 'posted' as const)
            .order('posted_at_utc', { ascending: false })
            .limit(1);
        if (lastSuccessError) {
            console.error('Scheduled Poster: Error fetching last successful post time:', lastSuccessError);
        }
        if (lastSuccess && lastSuccess.length > 0 && lastSuccess[0].posted_at_utc) {
            lastPostTimestampForScheduling = new Date(lastSuccess[0].posted_at_utc);
        }
    }

    let nextScheduledTimeUTC: Date;
    if (lastPostTimestampForScheduling) {
        nextScheduledTimeUTC = new Date(lastPostTimestampForScheduling.getTime() + (HOURS_BETWEEN_POSTS * 60 * 60 * 1000) + getRandomVariationMs());
    } else {
        // No posts ever, or last one very old. Schedule it soon.
        nextScheduledTimeUTC = new Date(Date.now() + MIN_TIME_BEFORE_FIRST_POST_MS + getRandomVariationMs());
    }
    // Ensure next post is not scheduled in the past if calculations are off or server time is weird
    if (nextScheduledTimeUTC.getTime() < Date.now()) {
        console.warn('Scheduled Poster: Calculated next schedule time is in the past. Adjusting to be in the near future.');
        nextScheduledTimeUTC = new Date(Date.now() + MIN_TIME_BEFORE_FIRST_POST_MS + Math.abs(getRandomVariationMs()));
    }

    const newPostEntry: Partial<PostLogEntry> = {
      topic: preparedData.topic || undefined,
      posted_text: preparedData.postText || undefined,
      raw_openai_response: preparedData.rawOpenAIResponse || undefined,
      persona_alignment_check: preparedData.personaAlignmentCheck || undefined,
      scheduled_time_utc: nextScheduledTimeUTC.toISOString(),
      search_topic: preparedData.searchTopic || undefined,
    };

    if (preparedData.success && preparedData.postText) {
      newPostEntry.status = 'ready_to_post' as const;
      await appendPostToLog(newPostEntry);
      console.log(`Scheduled Poster: Successfully prepared and scheduled next post. Topic: "${preparedData.topic}", Scheduled for: ${nextScheduledTimeUTC.toISOString()}`);
    } else {
      newPostEntry.status = 'generation_failed' as const;
      newPostEntry.error_message = preparedData.errorMessage || 'Unknown error during content generation.';
      await appendPostToLog(newPostEntry);
      console.error(`Scheduled Poster: Failed to prepare content for the next post. Error: ${newPostEntry.error_message}`);
    }
  }
  console.log('--- Scheduled Poster: Run Completed ---');
}

// --- Run Main Function ---
main()
  .then(() => {
    // Optional: Add a small delay if needed for any async operations to settle, though await should handle most.
    // console.log('Scheduled Poster: Process completed successfully in .then()');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Scheduled Poster: Unhandled error in main execution:', error);
    process.exit(1);
  }); 