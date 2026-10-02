#ifndef KEYSTONE_SPEECH_ADAPTER_H_
#define KEYSTONE_SPEECH_ADAPTER_H_

#include <stdint.h>

#if defined(_WIN32)
#define KEYSTONE_SPEECH_EXPORT __declspec(dllexport)
#elif defined(__GNUC__)
#define KEYSTONE_SPEECH_EXPORT __attribute__((visibility("default")))
#else
#define KEYSTONE_SPEECH_EXPORT
#endif

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Stable, product-specific ABI between keystone-media-worker and the pinned
 * sherpa-onnx adapter. The adapter owns every opaque handle it returns. Caller
 * memory is used for all variable-sized output, so no allocator crosses this
 * boundary.
 */

#define KEYSTONE_SPEECH_ADAPTER_ABI_VERSION 2u
#define KEYSTONE_SPEECH_SAMPLE_RATE 16000u
#define KEYSTONE_SPEECH_EMBEDDING_DIMENSION 512u
#define KEYSTONE_SPEECH_MAX_PCM_CHUNK_SAMPLES (5u * KEYSTONE_SPEECH_SAMPLE_RATE)
#define KEYSTONE_SPEECH_MAX_ASR_SAMPLES (60u * KEYSTONE_SPEECH_SAMPLE_RATE)
#define KEYSTONE_SPEECH_MAX_TEXT_BYTES (64u * 1024u)
#define KEYSTONE_SPEECH_MAX_DIARIZATION_SAMPLES \
  (300u * KEYSTONE_SPEECH_SAMPLE_RATE)
#define KEYSTONE_SPEECH_MAX_RAW_OBSERVATIONS 192u
#define KEYSTONE_SPEECH_MAX_LOCAL_SEGMENTS 16384u
#define KEYSTONE_SPEECH_MAX_CLUSTER_NODES 2048u

typedef enum keystoneSpeechStatus {
  KEYSTONE_SPEECH_STATUS_OK = 0,
  KEYSTONE_SPEECH_STATUS_INVALID_ARGUMENT = 1,
  KEYSTONE_SPEECH_STATUS_UNAVAILABLE = 2,
  KEYSTONE_SPEECH_STATUS_BUFFER_TOO_SMALL = 3,
  KEYSTONE_SPEECH_STATUS_MODEL_ERROR = 4,
  KEYSTONE_SPEECH_STATUS_INFERENCE_ERROR = 5,
  KEYSTONE_SPEECH_STATUS_RESOURCE_LIMIT = 6,
} keystoneSpeechStatus;

typedef struct keystoneSpeechBuildInfo {
  uint32_t struct_size;
  uint32_t abi_version;
  const char *sherpa_onnx_version;
  const char *sherpa_onnx_commit;
  const char *onnx_runtime_version;
  uint32_t sample_rate;
  uint32_t embedding_dimension;
} keystoneSpeechBuildInfo;

typedef struct keystoneSpeechUtf8Buffer {
  char *data;
  uint32_t capacity;
  uint32_t length;
} keystoneSpeechUtf8Buffer;

typedef struct keystoneSpeechAsrConfig {
  uint32_t struct_size;
  const char *sense_voice_model;
  const char *tokens;
  uint32_t num_threads;
  int32_t use_itn;
} keystoneSpeechAsrConfig;

typedef struct keystoneSpeechAsrResult {
  uint32_t struct_size;
  keystoneSpeechUtf8Buffer text;
  keystoneSpeechUtf8Buffer language;
  keystoneSpeechUtf8Buffer emotion;
  keystoneSpeechUtf8Buffer event;
} keystoneSpeechAsrResult;

typedef struct keystoneSpeechVadConfig {
  uint32_t struct_size;
  const char *silero_model;
  uint32_t num_threads;
  float threshold;
  float min_silence_seconds;
  float min_speech_seconds;
  float max_speech_seconds;
} keystoneSpeechVadConfig;

typedef struct keystoneSpeechVadSegment {
  uint32_t struct_size;
  uint64_t start_sample;
  float *samples;
  uint32_t sample_capacity;
  uint32_t sample_count;
} keystoneSpeechVadSegment;

typedef struct keystoneSpeechDiarizerConfig {
  uint32_t struct_size;
  const char *segmentation_model;
  const char *embedding_model;
  uint32_t num_threads;
  float segmentation_window_shift_ratio;
} keystoneSpeechDiarizerConfig;

typedef struct keystoneSpeechLocalSpeaker {
  uint32_t local_speaker;
  uint32_t chunk_index;
  uint32_t slot;
  uint32_t chunk_start;
  uint32_t chunk_end;
  uint32_t clean_samples;
  uint32_t embedding_status;
  /* UINT32_MAX for unavailable embeddings; otherwise an offset in floats. */
  uint32_t embedding_offset;
} keystoneSpeechLocalSpeaker;

typedef struct keystoneSpeechInterval {
  uint64_t start_sample;
  uint64_t end_sample;
} keystoneSpeechInterval;

typedef struct keystoneSpeechLocalSegment {
  uint64_t start_sample;
  uint64_t end_sample;
  uint32_t local_speaker;
} keystoneSpeechLocalSegment;

typedef struct keystoneSpeechDiarizationOutput {
  uint32_t struct_size;
  keystoneSpeechLocalSpeaker *speakers;
  uint32_t speaker_capacity;
  uint32_t speaker_count;
  keystoneSpeechLocalSegment *segments;
  uint32_t segment_capacity;
  uint32_t segment_count;
  keystoneSpeechLocalSegment *clean_segments;
  uint32_t clean_segment_capacity;
  uint32_t clean_segment_count;
  float *embeddings;
  uint32_t embedding_capacity;
  uint32_t embedding_count;
} keystoneSpeechDiarizationOutput;

typedef struct keystoneSpeechAsr keystoneSpeechAsr;
typedef struct keystoneSpeechVad keystoneSpeechVad;
typedef struct keystoneSpeechDiarizer keystoneSpeechDiarizer;
typedef struct keystoneSpeechDiarizationResult
    keystoneSpeechDiarizationResult;
typedef void (*keystoneSpeechEmbeddingStartedCallback)(void *user_data);

typedef struct keystoneSpeechAdapterApiV2 {
  uint32_t struct_size;
  uint32_t abi_version;

  keystoneSpeechStatus (*get_build_info)(keystoneSpeechBuildInfo *out);

  keystoneSpeechStatus (*create_asr)(const keystoneSpeechAsrConfig *config,
                                     keystoneSpeechAsr **out);
  void (*destroy_asr)(keystoneSpeechAsr *asr);
  keystoneSpeechStatus (*transcribe)(keystoneSpeechAsr *asr,
                                     const float *samples,
                                     uint32_t sample_count,
                                     keystoneSpeechAsrResult *out);

  keystoneSpeechStatus (*create_vad)(const keystoneSpeechVadConfig *config,
                                     keystoneSpeechVad **out);
  void (*destroy_vad)(keystoneSpeechVad *vad);
  keystoneSpeechStatus (*vad_accept)(keystoneSpeechVad *vad,
                                     const float *samples,
                                     uint32_t sample_count);
  keystoneSpeechStatus (*vad_flush)(keystoneSpeechVad *vad);
  keystoneSpeechStatus (*vad_pop)(keystoneSpeechVad *vad,
                                  keystoneSpeechVadSegment *out);
  keystoneSpeechStatus (*vad_reset)(keystoneSpeechVad *vad);

  keystoneSpeechStatus (*create_diarizer)(
      const keystoneSpeechDiarizerConfig *config,
      keystoneSpeechDiarizer **out);
  void (*destroy_diarizer)(keystoneSpeechDiarizer *diarizer);
  keystoneSpeechStatus (*diarize_window)(
      keystoneSpeechDiarizer *diarizer, const float *samples,
      uint32_t sample_count,
      const keystoneSpeechInterval *excluded, uint32_t excluded_count,
      keystoneSpeechEmbeddingStartedCallback embedding_started,
      void *user_data, keystoneSpeechDiarizationResult **out);
  keystoneSpeechStatus (*copy_diarization_result)(
      const keystoneSpeechDiarizationResult *result,
      keystoneSpeechDiarizationOutput *out);
  void (*destroy_diarization_result)(
      keystoneSpeechDiarizationResult *result);
  keystoneSpeechStatus (*cluster_distances)(
      const double *distances, uint32_t distance_count, uint32_t node_count,
      double distance_threshold, uint32_t *labels, uint32_t label_capacity,
      uint32_t *speaker_count);
} keystoneSpeechAdapterApiV2;

KEYSTONE_SPEECH_EXPORT const keystoneSpeechAdapterApiV2 *
keystone_speech_adapter_get_api(uint32_t requested_abi_version);

#ifdef __cplusplus
}
#endif

#endif  /* KEYSTONE_SPEECH_ADAPTER_H_ */
