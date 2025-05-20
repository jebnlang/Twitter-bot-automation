-- SQL for Supabase posts_news table

-- Create posts_news table
CREATE TABLE posts_news (
  id SERIAL PRIMARY KEY,
  article TEXT NOT NULL,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  posted_text TEXT,
  post_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  raw_openai_response JSONB,
  persona_alignment_check TEXT,
  scheduled_time_utc TIMESTAMPTZ,
  posted_at_utc TIMESTAMPTZ,
  generation_log JSONB,
  processed_at TIMESTAMPTZ
);

-- Add indexes for better performance
CREATE INDEX idx_posts_news_status ON posts_news(status);
CREATE INDEX idx_posts_news_timestamp ON posts_news(timestamp);

-- Create RLS policies (adjust as needed for your security requirements)
ALTER TABLE posts_news ENABLE ROW LEVEL SECURITY;

-- Allow all operations for authenticated users
CREATE POLICY "Enable all for authenticated users" ON posts_news
  FOR ALL
  TO authenticated
  USING (true);

-- Comment to help users
COMMENT ON TABLE posts_news IS 'Table for storing article URLs to be summarized and posted'; 