"use client";

//import react stuff
import { useState, useEffect, useCallback } from "react";
import { useQueue } from "@uidotdev/usehooks";

//import nextjs stuff
import Image from "next/image";

// import convex stuff for db
import { useMutation, useQuery, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";

//import deepgram stuff
import {
  CreateProjectKeyResponse,
  LiveClient,
  LiveTranscriptionEvents,
  createClient,
} from "@deepgram/sdk";

//import shadcnui stuff
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Toggle } from "@/components/ui/toggle";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

//import icon stuff
import { Mic, Pause, User } from "lucide-react";
import Dg from "@/app/dg.svg";

interface WordDetail {
  word: string;
  start: number;
  end: number;
  confidence: number;
  speaker: number;
  punctuated_word: string;
}

interface FinalizedSentence {
  speaker: string;
  transcript: string;
  start: number;
  end: number;
  meetingID: Id<"meetings">;
}

export default function Microphone({
  meetingID,
}: {
  meetingID: Id<"meetings">;
}) {
  const { add, remove, first, size, queue } = useQueue<any>([]);
  const [apiKey, setApiKey] = useState<CreateProjectKeyResponse | null>();
  const [connection, setConnection] = useState<LiveClient | null>();
  const [isListening, setListening] = useState(false);
  const [isLoadingKey, setLoadingKey] = useState(true);
  const [isLoading, setLoading] = useState(true);
  const [isProcessing, setProcessing] = useState(false);
  const [micOpen, setMicOpen] = useState(false);
  const [microphone, setMicrophone] = useState<MediaRecorder | null>();
  const [userMedia, setUserMedia] = useState<MediaStream | null>();
  const [caption, setCaption] = useState<string | null>();
  const [finalCaptions, setFinalCaptions] = useState<WordDetail[]>([]);
  const [finalizedSentences, setFinalizedSentences] = useState<
    FinalizedSentence[]
  >([]);

  // Define the mutation hook at the top of your component
  const storeFinalizedSentences = useMutation(
    api.transcript.storeFinalizedSentence
  );
  // Fetch finalized sentences for the given meetingID when the component mounts
  const finalizedSentencesFromDB = useQuery(
    api.transcript.getFinalizedSentencesByMeeting,
    { meetingID }
  );

  useEffect(() => {
    // Check if there are any finalized sentences fetched from the database
    if (finalizedSentencesFromDB && finalizedSentencesFromDB.length > 0) {
      // Handle the fetched finalized sentences as needed
      // For example, you might want to set them to your component's state
      setFinalizedSentences(finalizedSentencesFromDB);
    }
  }, [finalizedSentencesFromDB]);

  const createMeeting = useMutation(api.meetings.createMeeting);

  const toggleMicrophone = useCallback(async () => {
    if (microphone && userMedia) {
      setUserMedia(null);
      setMicrophone(null);

      microphone.stop();
      // console.log("Finalized Sentences:", finalizedSentences); // Log the finalized sentences when stopping the recording

      // Store finalized sentences in the database
      await Promise.all(
        finalizedSentences.map((sentence) => storeFinalizedSentences(sentence))
      );
    } else {
      const userMedia = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      const microphone = new MediaRecorder(userMedia);
      microphone.start(200);

      microphone.onstart = () => {
        setMicOpen(true);
      };

      microphone.onstop = () => {
        setMicOpen(false);
      };

      microphone.ondataavailable = (e) => {
        add(e.data);
      };

      setUserMedia(userMedia);
      setMicrophone(microphone);
    }
  }, [add, microphone, userMedia, finalizedSentences]);

  useEffect(() => {
    if (!apiKey) {
      // console.log("getting a new api key");
      fetch("/api", { cache: "no-store" })
        .then((res) => res.json())
        .then((object) => {
          if (!("key" in object)) throw new Error("No api key returned");

          setApiKey(object);
          setLoadingKey(false);
        })
        .catch((e) => {
          console.error(e);
        });
    }
  }, [apiKey]);

  useEffect(() => {
    if (apiKey && "key" in apiKey) {
      // console.log("connecting to deepgram");
      const deepgram = createClient(apiKey?.key ?? "");
      const connection = deepgram.listen.live({
        model: "nova-2",
        diarize: true,
        interim_results: true,
        smart_format: true,
      });

      connection.on(LiveTranscriptionEvents.Open, () => {
        // console.log("connection established");
        setListening(true);
      });

      connection.on(LiveTranscriptionEvents.Close, () => {
        // console.log("connection closed");
        setListening(false);
        setApiKey(null);
        setConnection(null);
      });

      connection.on(LiveTranscriptionEvents.Transcript, (data) => {
        // console.log(data);
        const words = data.channel.alternatives[0].words;
        const caption = words
          .map((word: any) => word.punctuated_word ?? word.word)
          .join(" ");
        if (caption !== "") {
          setCaption(caption);
          // Check if the transcript is final
          if (data.is_final) {
            // Update the finalCaptions array with word details
            setFinalCaptions((prevCaptions) => [
              ...prevCaptions,
              ...words.map((word: any) => ({
                word: word.word,
                start: word.start,
                end: word.end,
                confidence: word.confidence,
                speaker: word.speaker,
                punctuated_word: word.punctuated_word,
              })),
            ]);
          }
        }
      });

      setConnection(connection);
      setLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    const processQueue = async () => {
      if (size > 0 && !isProcessing) {
        setProcessing(true);

        if (isListening) {
          const blob = first;
          connection?.send(blob);
          remove();
        }

        const waiting = setTimeout(() => {
          clearTimeout(waiting);
          setProcessing(false);
        }, 250);
      }
    };

    processQueue();
  }, [connection, queue, remove, first, size, isProcessing, isListening]);

  // Function to process final captions and construct finalized sentences
  const processFinalCaptions = async (finalCaptions: WordDetail[]) => {
    const sentences: FinalizedSentence[] = [];
    let currentSpeaker = finalCaptions[0]?.speaker;
    let currentText = "";
    let startTime = finalCaptions[0]?.start;
    let endTime = finalCaptions[0]?.end;

    for (const wordDetail of finalCaptions) {
      if (
        wordDetail.speaker !== currentSpeaker ||
        wordDetail === finalCaptions[finalCaptions.length - 1]
      ) {
        if (wordDetail === finalCaptions[finalCaptions.length - 1]) {
          currentText += wordDetail.punctuated_word + " ";
          endTime = wordDetail.end;
        }

        sentences.push({
          speaker: `Speaker ${currentSpeaker}`,
          transcript: currentText.trim(),
          start: startTime,
          end: endTime,
          meetingID: meetingID,
        });

        currentSpeaker = wordDetail.speaker;
        currentText = wordDetail.punctuated_word + " ";
        startTime = wordDetail.start;
        endTime = wordDetail.end;
      } else {
        currentText += wordDetail.punctuated_word + " ";
        endTime = wordDetail.end;
      }
    }

    console.log("Finalized Sentences:", sentences);
    setFinalizedSentences(sentences);
  };

  // Call processFinalCaptions whenever finalCaptions is updated
  useEffect(() => {
    if (finalCaptions.length > 0) {
      processFinalCaptions(finalCaptions);
    }
  }, [finalCaptions]);

  if (isLoadingKey)
    return <span className="">Loading temporary API key...</span>;
  if (isLoading) return <span className="">Loading the app...</span>;

  return (
    <div className="flex flex-col">
      <div className="flex flex-col">
        {/* toggle microphone */}
        <Button
          variant={
            !!userMedia && !!microphone && micOpen ? "destructive" : "secondary"
          }
          size="icon"
          onClick={() => toggleMicrophone()}
          className={
            !!userMedia && !!microphone && micOpen
              ? "" // recording enabled
              : "" // recording disabled
          }
        >
          {!!userMedia && !!microphone && micOpen ? (
            <Pause className="w-6 h-6" />
          ) : (
            <Mic className="w-6 h-6" />
          )}
        </Button>
        {/* display is_final responses */}
        <div className="my-4 space-y-4">
          {finalizedSentences.slice(0, -1).map((sentence, index) => (
            <div key={index} className="flex flex-row">
              <Avatar className="">
                <AvatarImage src="" />
                <AvatarFallback>
                  <User />
                </AvatarFallback>
              </Avatar>
              <div className="flex flex-col ml-4 border rounded-lg p-4">
                <div className="flex flex-row justify-between mb-3">
                  <div className="font-bold">{sentence.speaker}</div>
                  <div className="text-muted-foreground">
                    {sentence.start.toFixed(2)} - {sentence.end.toFixed(2)}
                  </div>
                </div>
                {sentence.transcript}
              </div>
            </div>
          ))}
          {finalizedSentences.length > 0 && (
            <div key={finalizedSentences.length - 1} className="flex flex-row">
              <Avatar className="">
                <AvatarImage src="" />
                <AvatarFallback>
                  <User />
                </AvatarFallback>
              </Avatar>
              <div className="flex flex-col ml-4 border rounded-lg p-4">
                <div className="flex flex-row justify-between mb-3">
                  <div className="font-bold">
                    {finalizedSentences[finalizedSentences.length - 1].speaker}
                  </div>
                  <div className="text-muted-foreground">
                    {finalizedSentences[
                      finalizedSentences.length - 1
                    ].start.toFixed(2)}{" "}
                    -{" "}
                    {finalizedSentences[
                      finalizedSentences.length - 1
                    ].end.toFixed(2)}
                  </div>
                </div>
                <div>
                  {finalizedSentences[finalizedSentences.length - 1].transcript}{" "}
                  <span className="text-blue-500">{caption} </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      {/* connection indicator for deepgram via socket and temp api key */}
      {/* <div
        className="z-20 flex shrink-0 grow-0 justify-around items-center 
                  fixed bottom-0 right-0 rounded-lg mr-1 mb-5 lg:mr-5 lg:mb-5 xl:mr-10 xl:mb-10 gap-5"
      >
        <Button
          variant={isListening ? "secondary" : "outline"}
          className="space-x-2"
        >
          <Dg
            id="dg"
            width="24"
            height="24"
            className={isListening ? "" : ""}
          />
          <Label htmlFor="dg" className="">
            {isListening ? "connected" : "connecting"}
          </Label>
        </Button>
      </div> */}
    </div>
  );
}
