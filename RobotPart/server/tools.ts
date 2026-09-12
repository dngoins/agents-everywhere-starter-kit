import { z } from 'zod';

export const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
export const identitySchema = z.strictObject({ clientId: uuidSchema, customerId: uuidSchema });

export const toolSchemas = {
  offer_movie: z.strictObject({}),
  show_movie: z.strictObject({ accepted: z.boolean() }),
  movie_finished: z.strictObject({}),
  movie_feedback: z.strictObject({ liked: z.boolean() }),
  test_drive_interest: z.strictObject({ accepted: z.boolean() }),
  get_test_drive_slots: z.strictObject({}),
  book_test_drive: z.strictObject({
    slotId: z.string().min(1).max(200),
    car: z.enum(['model3', 'modely']),
    confirmed: z.boolean(),
  }),
  follow_customer: z.strictObject({
    destination: z.enum(['model3', 'modely']),
    confirmed: z.boolean(),
  }),
  stop_following: z.strictObject({}),
  ask_vehicle_expert: z.strictObject({
    question: z.string().trim().min(1).max(2000),
    deepReasoning: z.boolean(),
  }),
};

export type ToolName = keyof typeof toolSchemas;

// A discriminated union keeps dispatch fully typed without casting arbitrary args.
export const toolCallSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('offer_movie'), args: toolSchemas.offer_movie }),
  z.object({ name: z.literal('show_movie'), args: toolSchemas.show_movie }),
  z.object({ name: z.literal('movie_finished'), args: toolSchemas.movie_finished }),
  z.object({ name: z.literal('movie_feedback'), args: toolSchemas.movie_feedback }),
  z.object({ name: z.literal('test_drive_interest'), args: toolSchemas.test_drive_interest }),
  z.object({ name: z.literal('get_test_drive_slots'), args: toolSchemas.get_test_drive_slots }),
  z.object({ name: z.literal('book_test_drive'), args: toolSchemas.book_test_drive }),
  z.object({ name: z.literal('follow_customer'), args: toolSchemas.follow_customer }),
  z.object({ name: z.literal('stop_following'), args: toolSchemas.stop_following }),
  z.object({ name: z.literal('ask_vehicle_expert'), args: toolSchemas.ask_vehicle_expert }),
]);

const descriptions: Record<Exclude<ToolName, 'movie_finished'>, string> = {
  offer_movie: 'At a natural conversation pause, offer the ready demo movie. Call BEFORE asking video consent; never before ready or after declining.',
  show_movie: 'Record the customer\'s explicit answer to the movie offer. Play only with accepted=true.',
  movie_feedback: 'After the UI reports movie finished, record whether the customer liked it. Positive feedback offers a demo all-day drive.',
  test_drive_interest: 'Record explicit interest in a mock all-day test drive. Accepted interest displays pickup slots.',
  get_test_drive_slots: 'Refresh the three offered pickup slots for tomorrow in Eastern Time while selecting. Return is 6 PM that same day.',
  book_test_drive: 'Record a DEMO booking only after summarizing the chosen car, pickup, same-day 6 PM return and receiving explicit confirmation. Never a real reservation.',
  follow_customer: 'Only after explicit agreement, request camera-based following toward a demo car. Customer must face the camera; stop if face lost. No mapped navigation.',
  stop_following: 'Stop camera-based following when the customer says stop.',
  ask_vehicle_expert: 'Answer a vehicle question from demo facts without inventing specifications or pricing. Set deepReasoning=true ONLY for genuinely complex reasoning.',
};

export const modelTools = Object.entries(descriptions).map(([name, description]) => {
  const { $schema: _schema, ...parameters } = z.toJSONSchema(toolSchemas[name as keyof typeof descriptions]);
  return { type: 'function' as const, name, description, parameters, strict: true as const };
});