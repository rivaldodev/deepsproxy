import { Hono } from 'hono';

const models = new Hono();

const MODEL_IDS = [
  'deepseek-thinking',
  'deepseek-no-thinking',
];

function modelObject(id: string) {
  return {
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'deepseek',
    permission: [],
    root: id,
    parent: null,
  };
}

models.get('/', (c) => {
  return c.json({
    object: 'list',
    data: MODEL_IDS.map(modelObject),
  });
});

models.get('/:model', (c) => {
  const id = c.req.param('model');
  return c.json(modelObject(id));
});

export { models, MODEL_IDS };
