-- SQL for Supabase schema updates

-- 1. Add search_topic column to posts table
ALTER TABLE posts ADD COLUMN search_topic TEXT;

-- 2. Create search_topics table
CREATE TABLE search_topics (
  id SERIAL PRIMARY KEY,
  topic TEXT NOT NULL,
  category TEXT,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Insert initial topics
INSERT INTO search_topics (topic, category) VALUES
-- Prompt Engineering
('advanced prompt engineering techniques', 'prompt_engineering'),
('zero-shot prompt design strategies', 'prompt_engineering'),
('prompt engineering best practices', 'prompt_engineering'),
('chain of thought prompting', 'prompt_engineering'),
-- Vibe Coding
('modern coding practices', 'coding'),
('developer productivity tools', 'coding'),
('AI pair programming', 'coding'),
('clean code principles', 'coding'),
-- AI Platforms
('no-code AI development platforms', 'ai_platforms'),
('low-code AI application builders', 'ai_platforms'),
('AI automation tools', 'ai_platforms'),
-- Image Generation
('AI image generation prompts', 'image_generation'),
('DALL-E optimization techniques', 'image_generation'),
('Midjourney prompt crafting', 'image_generation'),
-- Marketing
('AI content marketing strategies', 'marketing'),
('prompt-based marketing automation', 'marketing'),
('personalized AI content creation', 'marketing'),
-- Tools
('prompt generator tools', 'tools'),
('prompt improvement techniques', 'tools'),
('AI workflow optimization', 'tools');
