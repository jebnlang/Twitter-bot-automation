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
const MIN_TIME_BEFORE_FIRST_POST_MS = 0; // Immediate posting for first run

// --- New Time Window Constants ---
// Buffer window: post can be published up to this many minutes early
const SCHEDULE_BUFFER_MINUTES = 30;
// Grace period: post can be published up to this many hours late before considered missed
const SCHEDULE_GRACE_PERIOD_HOURS = 2;

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

// --- Helper: Check if a scheduled time is within the posting window ---
function isTimeToPost(scheduledTime: Date): boolean {
  const now = new Date();
  
  // Calculate buffer window start (scheduledTime minus buffer)
  const bufferWindowStart = new Date(scheduledTime.getTime() - (SCHEDULE_BUFFER_MINUTES * 60 * 1000));
  
  // Calculate grace period end (scheduledTime plus grace period)
  const gracePeriodEnd = new Date(scheduledTime.getTime() + (SCHEDULE_GRACE_PERIOD_HOURS * 60 * 60 * 1000));
  
  // Check if current time is between buffer window start and grace period end
  const isWithinPostingWindow = now >= bufferWindowStart && now <= gracePeriodEnd;
  
  // Log detailed time information for debugging
  console.log(`Scheduled Poster: Time check details:`);
  console.log(`  Current time (UTC): ${now.toISOString()}`);
  console.log(`  Scheduled time (UTC): ${scheduledTime.toISOString()}`);
  console.log(`  Buffer window starts: ${bufferWindowStart.toISOString()} (${SCHEDULE_BUFFER_MINUTES} mins before)`);
  console.log(`  Grace period ends: ${gracePeriodEnd.toISOString()} (${SCHEDULE_GRACE_PERIOD_HOURS} hours after)`);
  console.log(`  Is within posting window: ${isWithinPostingWindow}`);
  
  return isWithinPostingWindow;
}

// --- Helper: Reset orphaned posts ---
async function resetOrphanedPosts(): Promise<void> {
  try {
    // Find posts that are in 'ready_to_post' status but their scheduled time is too far in the past
    // These are considered "orphaned" - they missed their window
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - (SCHEDULE_GRACE_PERIOD_HOURS + 1)); // Beyond grace period
    
    const { data: orphanedPosts, error } = await supabase
      .from('posts')
      .select('id, topic, scheduled_time_utc')
      .eq('status', 'ready_to_post')
      .lt('scheduled_time_utc', cutoffTime.toISOString())
      .order('scheduled_time_utc');
    
    if (error) {
      console.error('Scheduled Poster: Error checking for orphaned posts:', error);
      return;
    }
    
    if (orphanedPosts && orphanedPosts.length > 0) {
      console.log(`Scheduled Poster: Found ${orphanedPosts.length} orphaned post(s) that missed their posting window:`);
      
      for (const post of orphanedPosts) {
        console.log(`  Post ID ${post.id}: "${post.topic}" scheduled for ${post.scheduled_time_utc}`);
        
        await supabase
          .from('posts')
          .update({
            status: 'missed_schedule',
            error_message: `Post missed its scheduled time. Was due at ${post.scheduled_time_utc}, detected at ${new Date().toISOString()}.`
          })
          .eq('id', post.id);
        
        console.log(`  Marked post ID ${post.id} as 'missed_schedule'`);
      }
    }
  } catch (error) {
    console.error('Scheduled Poster: Error in resetOrphanedPosts:', error);
  }
}

// --- Helper: Check for ready posts ---
async function findReadyPost(): Promise<PostLogEntry | null> {
  try {
    const { data: readyPosts, error: fetchError } = await supabase
      .from('posts')
      .select('*')
      .eq('status', 'ready_to_post')
      .order('scheduled_time_utc', { ascending: true })
      .limit(5); // Get several posts to check multiple if needed
    
    if (fetchError) {
      console.error('Scheduled Poster: Error fetching ready posts:', fetchError);
      return null;
    }
    
    if (!readyPosts || readyPosts.length === 0) {
      console.log('Scheduled Poster: No ready posts found');
      return null;
    }
    
    console.log(`Scheduled Poster: Found ${readyPosts.length} post(s) with 'ready_to_post' status`);
    
    // Check each post to see if it's ready to be posted based on its scheduled time
    for (const post of readyPosts) {
      const scheduledTime = new Date(post.scheduled_time_utc!);
      
      if (isTimeToPost(scheduledTime)) {
        console.log(`Scheduled Poster: Post ID ${post.id} is ready to be posted now`);
        return post as PostLogEntry;
      }
      
      console.log(`Scheduled Poster: Post ID ${post.id} is not yet ready to be posted (scheduled for ${scheduledTime.toISOString()})`);
    }
    
    console.log('Scheduled Poster: No posts are within their posting window yet');
    return null;
  } catch (error) {
    console.error('Scheduled Poster: Error in findReadyPost:', error);
    return null;
  }
}

// --- Main Orchestration Logic ---
async function main() {
  console.log('\n--- Scheduled Poster: Starting Run ---');
  console.log(`Scheduled Poster: Current time (UTC): ${new Date().toISOString()}`);

  // First check for any orphaned posts and mark them appropriately
  await resetOrphanedPosts();

  // Check for posts that are ready to be published
  const postToPublish = await findReadyPost();
  
  let postPublishedInThisRun = false;
  let lastPostTimestampForScheduling: Date | null = null;

  // If we found a post ready to be published, publish it
  if (postToPublish) {
    console.log(`Scheduled Poster: Found a post "${postToPublish.topic || 'Untitled'}" ready to be published now`);
    
    try {
      const postUrl = await publishTwitterPost(postToPublish.posted_text!);
      const currentTimeUTC = new Date().toISOString();

      // Consider both actual URLs and the POSTED_SUCCESSFULLY marker as success
      if (postUrl) {
        try {
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
        } catch (updateError) {
          console.error(`Scheduled Poster: Error updating post status after publishing:`, updateError);
        }
      } else {
        try {
          await supabase
            .from('posts')
            .update({
              status: 'failed_to_post' as const,
              error_message: 'Publishing failed or URL not retrieved.',
              posted_at_utc: currentTimeUTC,
            })
            .eq('id', postToPublish.id!);
          console.error(`Scheduled Poster: Failed to publish post ID ${postToPublish.id}.`);
        } catch (updateError) {
          console.error(`Scheduled Poster: Error updating post status after publishing failure:`, updateError);
        }
      }
    } catch (publishError: any) {
      console.error('Scheduled Poster: Error during post publishing:', publishError);
      try {
        await supabase
          .from('posts')
          .update({
            status: 'failed_to_post' as const,
            error_message: `Publishing error: ${publishError.message || 'Unknown error'}`,
            posted_at_utc: new Date().toISOString(),
          })
          .eq('id', postToPublish.id!);
      } catch (updateError) {
        console.error(`Scheduled Poster: Error updating post status after publishing exception:`, updateError);
      }
    }
  } else {
    console.log('Scheduled Poster: No ready posts found that need to be published now');
  }

  // Check if we need to prepare a new post
  const needToPreparePosts = async (): Promise<boolean> => {
    try {
      // Check for any posts with 'ready_to_post' status
      const { data: existingReadyCheck, error: existingReadyError } = await supabase
        .from('posts')
        .select('id, scheduled_time_utc')
        .eq('status', 'ready_to_post')
        .order('scheduled_time_utc', { ascending: true })
        .limit(1);

      if (existingReadyError) {
        console.error('Scheduled Poster: Error checking for existing ready posts:', existingReadyError);
        return true; // Default to preparing posts on error
      }

      // If we published a post in this run, or there are no ready posts, we need to prepare one
      return postPublishedInThisRun || !existingReadyCheck || existingReadyCheck.length === 0;
    } catch (error) {
      console.error('Scheduled Poster: Error in needToPreparePosts:', error);
      return true; // Default to preparing posts on error
    }
  };

  // Prepare a new post if needed
  if (await needToPreparePosts()) {
    console.log('Scheduled Poster: Preparing data for the next post...');
    
    try {
      const preparedData = await preparePostData();
      
      // Calculate when the next post should be scheduled
      if (!lastPostTimestampForScheduling) {
        try {
          const { data: lastSuccess, error: lastSuccessError } = await supabase
            .from('posts')
            .select('posted_at_utc')
            .eq('status', 'posted')
            .order('posted_at_utc', { ascending: false })
            .limit(1);
          
          if (lastSuccessError) {
            console.error('Scheduled Poster: Error fetching last successful post time:', lastSuccessError);
          } else if (lastSuccess && lastSuccess.length > 0 && lastSuccess[0].posted_at_utc) {
            lastPostTimestampForScheduling = new Date(lastSuccess[0].posted_at_utc);
            console.log(`Scheduled Poster: Found last post timestamp: ${lastPostTimestampForScheduling.toISOString()}`);
          } else {
            console.log('Scheduled Poster: No previous posts found, will schedule first post');
          }
        } catch (error) {
          console.error('Scheduled Poster: Error determining last post time:', error);
        }
      }

      let nextScheduledTimeUTC: Date;
      let postImmediately = false;
      
      if (lastPostTimestampForScheduling) {
        // Normal scheduling based on last post time
        nextScheduledTimeUTC = new Date(lastPostTimestampForScheduling.getTime() + (HOURS_BETWEEN_POSTS * 60 * 60 * 1000) + getRandomVariationMs());
        console.log(`Scheduled Poster: Calculated next post time based on last post at ${lastPostTimestampForScheduling.toISOString()}`);
      } else {
        // This is a first post situation (no previous posts found)
        
        // Check if we should post immediately after deployment
        if (MIN_TIME_BEFORE_FIRST_POST_MS === 0) {
          console.log('Scheduled Poster: First post after deployment - scheduling for immediate posting');
          nextScheduledTimeUTC = new Date(); // Schedule for now
          postImmediately = true;
        } else {
          // Use the small delay as configured
          nextScheduledTimeUTC = new Date(Date.now() + MIN_TIME_BEFORE_FIRST_POST_MS + getRandomVariationMs());
          console.log(`Scheduled Poster: Scheduling first post with small delay: ${nextScheduledTimeUTC.toISOString()}`);
        }
      }
      
      // Ensure next post is not scheduled in the past
      if (!postImmediately && nextScheduledTimeUTC.getTime() < Date.now()) {
        console.warn('Scheduled Poster: Calculated next schedule time is in the past. Adjusting to be in the near future.');
        nextScheduledTimeUTC = new Date(Date.now() + Math.abs(getRandomVariationMs())); // Small random delay
        console.log(`Scheduled Poster: Adjusted schedule time to: ${nextScheduledTimeUTC.toISOString()}`);
      }

      const newPostEntry: Partial<PostLogEntry> = {
        topic: preparedData.topic || undefined,
        posted_text: preparedData.postText || undefined,
        raw_openai_response: preparedData.rawOpenAIResponse || undefined,
        persona_alignment_check: preparedData.personaAlignmentCheck || undefined,
        scheduled_time_utc: nextScheduledTimeUTC.toISOString(),
      };

      // Log the search topic that was used
      if (preparedData.searchTopic) {
        console.log(`Scheduled Poster: Used search topic: "${preparedData.searchTopic}" to generate content about "${preparedData.topic}"`);
      }

      if (preparedData.success && preparedData.postText) {
        // First determine if we should immediately publish this post
        if (postImmediately) {
          console.log(`Scheduled Poster: Post deployment immediate publishing mode activated`);
          
          try {
            // First save with "ready_to_post" status, but we'll immediately publish it
            newPostEntry.status = 'ready_to_post' as const;
            const { data: savedPost, error: saveError } = await supabase
              .from('posts')
              .insert([newPostEntry])
              .select()
              .single();
              
            if (saveError) {
              console.error('Scheduled Poster: Error saving new post:', saveError);
              return;
            }
            
            console.log(`Scheduled Poster: New post saved with ID ${savedPost.id}, now publishing immediately`);
            
            // Immediately publish it
            const postUrl = await publishTwitterPost(savedPost.posted_text);
            const currentTimeUTC = new Date().toISOString();
            
            // Consider both actual URLs and the POSTED_SUCCESSFULLY marker as success
            if (postUrl) {
              try {
                await supabase
                  .from('posts')
                  .update({
                    status: 'posted' as const,
                    post_url: postUrl === "POSTED_SUCCESSFULLY" ? "https://x.com/posted-successfully" : postUrl,
                    posted_at_utc: currentTimeUTC,
                    error_message: null 
                  })
                  .eq('id', savedPost.id);
                console.log(`Scheduled Poster: Successfully published post ID ${savedPost.id} immediately after preparation. ${postUrl === "POSTED_SUCCESSFULLY" ? "URL retrieval skipped." : `URL: ${postUrl}`}`);
              } catch (updateError) {
                console.error('Scheduled Poster: Error updating post status after immediate publishing:', updateError);
              }
              
              // Instead of recursive call which might not complete, directly prepare the next post here
              console.log(`Scheduled Poster: Preparing the next scheduled post after immediate publishing...`);
              
              try {
                // Prepare next post
                const nextPreparedData = await preparePostData();
                
                // Calculate next scheduled time (6 hours from now)
                const nextScheduledTimeUTC = new Date(Date.now() + (HOURS_BETWEEN_POSTS * 60 * 60 * 1000) + getRandomVariationMs());
                
                // Create entry for next post
                const nextPostEntry: Partial<PostLogEntry> = {
                  topic: nextPreparedData.topic || undefined,
                  posted_text: nextPreparedData.postText || undefined,
                  raw_openai_response: nextPreparedData.rawOpenAIResponse || undefined,
                  persona_alignment_check: nextPreparedData.personaAlignmentCheck || undefined,
                  scheduled_time_utc: nextScheduledTimeUTC.toISOString(),
                  status: 'ready_to_post' as const
                };
                
                // Log the search topic
                if (nextPreparedData.searchTopic) {
                  console.log(`Scheduled Poster: Used search topic: "${nextPreparedData.searchTopic}" to generate next scheduled content about "${nextPreparedData.topic}"`);
                }
                
                if (nextPreparedData.success && nextPreparedData.postText) {
                  try {
                    const { data: nextSavedPost, error: nextSaveError } = await supabase
                      .from('posts')
                      .insert([nextPostEntry])
                      .select()
                      .single();
                    
                    if (nextSaveError) {
                      console.error('Scheduled Poster: Error saving next post:', nextSaveError);
                    } else {
                      console.log(`Scheduled Poster: Successfully prepared and scheduled next post (ID ${nextSavedPost.id}) for ${nextScheduledTimeUTC.toISOString()}.`);
                      console.log(`Scheduled Poster: Next post topic: "${nextPreparedData.topic}"`);
                    }
                  } catch (error) {
                    console.error('Scheduled Poster: Error saving next prepared post:', error);
                  }
                } else {
                  console.error(`Scheduled Poster: Failed to prepare next post after immediate publishing. Error: ${nextPreparedData.errorMessage || 'Unknown error'}`);
                }
              } catch (error) {
                console.error('Scheduled Poster: Error preparing next post after immediate publishing:', error);
              }
              
              console.log(`Scheduled Poster: Run completed with current post published and next post scheduled.`);
              // Exit without recursively calling main()
              return;
            } else {
              try {
                await supabase
                  .from('posts')
                  .update({
                    status: 'failed_to_post' as const,
                    error_message: 'Immediate publishing failed or URL not retrieved.',
                    posted_at_utc: currentTimeUTC,
                  })
                  .eq('id', savedPost.id);
                console.error(`Scheduled Poster: Failed to publish post ID ${savedPost.id} immediately.`);
              } catch (updateError) {
                console.error('Scheduled Poster: Error updating post status after failed immediate publishing:', updateError);
              }
            }
          } catch (error) {
            console.error('Scheduled Poster: Error during immediate post publishing flow:', error);
          }
        } else {
          // Normal scheduling
          try {
            newPostEntry.status = 'ready_to_post' as const;
            const { data: savedPost, error: saveError } = await supabase
              .from('posts')
              .insert([newPostEntry])
              .select()
              .single();
            
            if (saveError) {
              console.error('Scheduled Poster: Error saving scheduled post:', saveError);
            } else {
              console.log(`Scheduled Poster: Successfully prepared and scheduled post (ID ${savedPost.id}) for ${nextScheduledTimeUTC.toISOString()}.`);
              console.log(`Scheduled Poster: Scheduled post topic: "${preparedData.topic}"`);
            }
          } catch (error) {
            console.error('Scheduled Poster: Error saving new scheduled post:', error);
          }
        }
      } else {
        try {
          newPostEntry.status = 'generation_failed' as const;
          newPostEntry.error_message = preparedData.errorMessage || 'Unknown error during content generation.';
          const { error: saveError } = await supabase
            .from('posts')
            .insert([newPostEntry]);
          
          if (saveError) {
            console.error('Scheduled Poster: Error saving failed generation post:', saveError);
          } else {
            console.error(`Scheduled Poster: Failed to prepare content for the next post. Error: ${newPostEntry.error_message}`);
          }
        } catch (error) {
          console.error('Scheduled Poster: Error saving generation failure record:', error);
        }
      }
    } catch (error) {
      console.error('Scheduled Poster: Unhandled error during post preparation:', error);
    }
  } else {
    console.log('Scheduled Poster: A post is already scheduled for the future. No need to prepare another one.');
  }
  
  console.log('--- Scheduled Poster: Run Completed ---');
}

// Run with more robust error handling
process.on('uncaughtException', (error) => {
  console.error('Scheduled Poster: UNCAUGHT EXCEPTION:', error);
  // Try to log to Supabase if possible
  try {
    const errorLog = {
      status: 'system_error' as const,
      error_message: `Uncaught exception: ${error.message}`,
      topic: 'System Error'
    };
    
    // Use async/await pattern instead of then/catch
    (async () => {
      try {
        await supabase.from('posts').insert([errorLog]);
        console.log('Scheduled Poster: Error logged to Supabase');
      } catch (err: any) {
        console.error('Scheduled Poster: Failed to log error to Supabase:', err);
      } finally {
        process.exit(1);
      }
    })();
    
  } catch (e) {
    console.error('Scheduled Poster: Error handling uncaught exception:', e);
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Scheduled Poster: UNHANDLED REJECTION:', reason);
  // Try to log to Supabase if possible
  try {
    const errorLog = {
      status: 'system_error' as const,
      error_message: `Unhandled rejection: ${reason}`,
      topic: 'System Error'
    };
    
    // Use async/await pattern instead of then/catch
    (async () => {
      try {
        await supabase.from('posts').insert([errorLog]);
        console.log('Scheduled Poster: Error logged to Supabase');
      } catch (err: any) {
        console.error('Scheduled Poster: Failed to log error to Supabase:', err);
      } finally {
        process.exit(1);
      }
    })();
    
  } catch (e) {
    console.error('Scheduled Poster: Error handling unhandled rejection:', e);
    process.exit(1);
  }
});

main()
  .then(() => {
    // Give some time for any remaining async operations to complete
    setTimeout(() => {
      console.log('Scheduled Poster: Clean exit.');
      process.exit(0);
    }, 3000);
  })
  .catch((error) => {
    console.error('Scheduled Poster: Unhandled error in main execution:', error);
    process.exit(1);
  }); 