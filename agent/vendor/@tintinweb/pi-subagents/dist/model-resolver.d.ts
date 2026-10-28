/**
 * Model resolution: exact match ("provider/modelId") with fuzzy fallback.
 */
export interface ModelEntry {
    id: string;
    name: string;
    provider: string;
}
export interface ModelRegistry {
    find(provider: string, modelId: string): any;
    getAll(): any[];
    getAvailable?(): any[];
}
/**
 * Both display forms of a model. The short one goes on tight rows (the widget,
 * the Agent tool result), the canonical one where there is room to disambiguate
 * two providers serving a similarly-named model (the conversation viewer).
 *
 * One function, because `index.ts` labels the model it resolved before the run
 * and `agent-manager.ts` relabels it from the live session afterwards — the two
 * must agree or the label would visibly change the moment the session starts.
 */
export declare function describeModel(model: {
    provider: string;
    id: string;
    name?: string;
}): {
    modelName: string;
    modelId: string;
};
/**
 * Resolve a model string to a Model instance.
 * Tries exact match first ("provider/modelId"), then fuzzy match against all available models.
 * Returns the Model on success, or an error message string on failure.
 */
export declare function resolveModel(input: string, registry: ModelRegistry): any | string;
