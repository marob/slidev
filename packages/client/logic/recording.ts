import { getSeekableBlob } from 'recordrtc'
import type { Ref } from 'vue'
import { nextTick, ref, shallowRef, watch } from 'vue'
import { useDevicesList, useEventListener } from '@vueuse/core'
import { isTruthy } from '@antfu/utils'
import type RecorderType from 'recordrtc'
import type { Options as RecorderOptions } from 'recordrtc'
// @ts-expect-error: waiting for v2.0.2 to be available to have .d.ts files: https://github.com/jimmywarting/native-file-system-adapter/issues/27
import { showSaveFilePicker } from 'native-file-system-adapter'
import { currentCamera, currentMic } from '../state'

import 'recordrtc-github/libs/EBML'

export const recordingName = ref('')
export const recordCamera = ref(true)

export function getFilename(media?: string) {
  const d = new Date()

  const pad = (v: number) => `${v}`.padStart(2, '0')

  const date = `${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`

  return `${[media, recordingName.value, date].filter(isTruthy).join('-')}.webm`
}

export const {
  videoInputs: cameras,
  audioInputs: microphones,
  ensurePermissions: ensureDevicesListPermissions,
} = useDevicesList({
  onUpdated() {
    if (currentCamera.value !== 'none') {
      if (!cameras.value.find(i => i.deviceId === currentCamera.value))
        currentCamera.value = cameras.value[0]?.deviceId || 'default'
    }
    if (currentMic.value !== 'none') {
      if (!microphones.value.find(i => i.deviceId === currentMic.value))
        currentMic.value = microphones.value[0]?.deviceId || 'default'
    }
  },
})

export function download(name: string, url: string) {
  const a = document.createElement('a')
  a.setAttribute('href', url)
  a.setAttribute('download', name)
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

export function useRecording() {
  const recording = ref(false)
  const showAvatar = ref(false)

  const recorderCamera: Ref<RecorderType | undefined> = shallowRef()
  const recorderSlides: Ref<RecorderType | undefined> = shallowRef()
  const streamCamera: Ref<MediaStream | undefined> = shallowRef()
  const streamSlides: Ref<MediaStream | undefined> = shallowRef()

  const config: RecorderOptions = {
    type: 'video',
    bitsPerSecond: 4 * 256 * 8 * 1024,
    timeSlice: 1000,
  }

  async function toggleAvatar() {
    if (currentCamera.value === 'none')
      return

    if (showAvatar.value) {
      showAvatar.value = false
      if (!recording.value)
        closeStream(streamCamera)
    }
    else {
      await startCameraStream()
      if (streamCamera.value)
        showAvatar.value = !!streamCamera.value
    }
  }

  async function startCameraStream() {
    await ensureDevicesListPermissions()
    await nextTick()
    if (!streamCamera.value) {
      if (currentCamera.value === 'none' && currentMic.value === 'none')
        return

      streamCamera.value = await navigator.mediaDevices.getUserMedia({
        video: currentCamera.value === 'none' || recordCamera.value !== true
          ? false
          : {
            deviceId: currentCamera.value,
          },
        audio: currentMic.value === 'none'
          ? false
          : {
            deviceId: currentMic.value,
          },
      })
    }
  }

  watch(currentCamera, async(v) => {
    if (v === 'none') {
      closeStream(streamCamera)
    }
    else {
      if (recording.value)
        return
      // restart camera stream
      if (streamCamera.value) {
        closeStream(streamCamera)
        await startCameraStream()
      }
    }
  })

  async function getFileHandle(fileName: string) {
    return await showSaveFilePicker({
      excludeAcceptAllOption: true,
      suggestedName: fileName,
      types: [{
        description: 'WEBM video',
        accept: { 'video/webm': ['.webm'] },
      }],
    })
  }

  function makeSeekable(fileHandle) {
    return async function() {
      const file = await fileHandle.getFile()
      const blob = file.slice()

      getSeekableBlob(blob, async(seekableBlob) => {
        const rewriteStream = await fileHandle.createWritable()
        await rewriteStream.write(seekableBlob)
        await rewriteStream.close()
      })
    }
  }

  async function startRecording() {
    // Starting by getting file handles as otherwise browser could refuse if it's triggered after a long time after a click
    let cameraFileHandle
    if (recordCamera.value)
      cameraFileHandle = await getFileHandle(getFilename('camera'))
    const screenFileHandle = await getFileHandle(getFilename('screen'))

    await ensureDevicesListPermissions()
    const { default: Recorder } = await import('recordrtc')
    await startCameraStream()

    streamSlides.value = await navigator.mediaDevices.getDisplayMedia({
      video: {
        // aspectRatio: 1.6,
        frameRate: 15,
        width: 3840,
        height: 2160,
        // @ts-expect-error missing types
        cursor: 'motion',
        resizeMode: 'crop-and-scale',
      },
    })

    if (streamCamera.value) {
      const audioTrack = streamCamera.value!.getAudioTracks()?.[0]
      if (audioTrack)
        streamSlides.value!.addTrack(audioTrack)

      if (recordCamera.value && cameraFileHandle) {
        recorderCamera.value = new Recorder(
          streamCamera.value!,
          {
            ...config,
            // @ts-expect-error missing types
            writableStream: await cameraFileHandle.createWritable(),
            onWritableStreamClosed: makeSeekable(cameraFileHandle),
          },
        )
        recorderCamera.value.startRecording()
      }
    }

    recorderSlides.value = new Recorder(
      streamSlides.value!,
      {
        ...config,
        // @ts-expect-error missing types
        writableStream: await screenFileHandle.createWritable(),
        onWritableStreamClosed: makeSeekable(screenFileHandle),
      },
    )

    recorderSlides.value.startRecording()
    recording.value = true
  }

  async function stopRecording() {
    recording.value = false
    recorderCamera.value?.stopRecording(() => {
      recorderCamera.value = undefined
      if (!showAvatar.value)
        closeStream(streamCamera)
    })
    recorderSlides.value?.stopRecording(() => {
      closeStream(streamSlides)
      recorderSlides.value = undefined
    })
  }

  function closeStream(stream: Ref<MediaStream | undefined>) {
    const s = stream.value
    if (!s)
      return
    s.getTracks().forEach((i) => {
      i.stop()
      s.removeTrack(i)
    })
    stream.value = undefined
  }

  useEventListener('beforeunload', (event) => {
    if (!recording.value)
      return
    // eslint-disable-next-line no-alert
    if (confirm('Recording is not saved yet, do you want to leave?'))
      return
    event.preventDefault()
    event.returnValue = ''
  })

  return {
    recording,
    showAvatar,
    startRecording,
    stopRecording,
    toggleAvatar,
    recorderCamera,
    recorderSlides,
    streamCamera,
    streamSlides,
  }
}

export const recorder = useRecording()
