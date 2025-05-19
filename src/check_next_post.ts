import { config as dotenvConfig } from 'dotenv';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Load environment variables
dotenvConfig();

// Supabase Client
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('CheckNextPost: Error - SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not defined.');
  process.exit(1);
}

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function checkAndLogNextPost() {
  console.log('\n--- CheckNextPost: Checking for next scheduled post ---');
  try {
    const { data: nextPost, error } = await supabase
      .from('posts')
      .select('topic, scheduled_time_utc')
      .eq('status', 'ready_to_post')
      .order('scheduled_time_utc', { ascending: true })
      .limit(1)
      .maybeSingle(); // Returns a single object or null, not an array

    if (error) {
      console.error('CheckNextPost: Error fetching next scheduled post:', error.message);
      return;
    }

    if (nextPost && nextPost.scheduled_time_utc) {
      const scheduledTime = new Date(nextPost.scheduled_time_utc);
      console.log(`CheckNextPost: Next post is scheduled for: ${scheduledTime.toISOString()}`);
      console.log(`CheckNextPost: Topic: "${nextPost.topic || 'N/A'}"`);
    } else {
      console.log("CheckNextPost: No posts currently scheduled (status 'ready_to_post').");
    }
  } catch (e: any) {
    console.error('CheckNextPost: Unexpected error:', e.message);
  } finally {
    console.log('--- CheckNextPost: Check complete ---');
    // No process.exit here, let the script end naturally if it's a short-lived cron
    // If it were a long-running process, you might handle it differently.
  }
}

checkAndLogNextPost(); 