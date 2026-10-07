harness features to implement:
------------------------------

* support video/audio input. add indicators to harness indicating which input types the currently selected model has access to
* attachments skill. this indicates how the model should handle attachments of different types that are NOT natively handled by the model. for instance, the attachments skill might tell models that have image support but not video "when model does not have native video support, do the following: (1) use ffmpeg to extract 10 evenly spaced frames from the video. save these frames as jpeg and use in request (2) use ffmpeg to extract audio, then speech to text to generated relevant text. mention generated relevant text in the prompt.
* /suggest command, which will suggest a model to use based on the complexity of the current task.
* dictation - speech to text would be a really nice feature
