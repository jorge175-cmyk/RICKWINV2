CREATE POLICY "Service role manages IQ Option connection state"
ON public.iqoption_connection_state
FOR ALL
TO service_role
USING (TRUE)
WITH CHECK (TRUE);